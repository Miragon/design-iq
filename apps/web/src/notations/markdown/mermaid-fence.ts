/**
 * ```mermaid fences in the Markdown view, drawn as diagrams: the first entry
 * of the fence extension point (./fences.ts), on the app's one Mermaid
 * renderer (lib/mermaid-render.ts: strict security level, the CI theme,
 * Geist).
 *
 * - `render` (the HTML pass) keeps the fence a code block, marked
 *   `md-mermaid`, with its source as text: what a reader sees until the
 *   diagram is drawn, and what stays when it cannot be.
 * - `hydrate` (the DOM) draws every such block. The renderer, and mermaid
 *   behind it, load here, so only a document with a mermaid fence fetches
 *   them (ADR 0006).
 * - Drawings are cached by source: a re-render for an edit elsewhere puts the
 *   same diagrams back before the browser paints, and only a changed diagram
 *   is drawn again. Until it is, its block keeps what it showed (the n-th
 *   diagram keeps the n-th one's drawing while no diagram is added or
 *   removed), so a live edit never flashes a diagram back to code.
 * - A source mermaid cannot read gets a notice (the error and its line)
 *   under the block's last good drawing, dimmed, or under its code when it
 *   never drew.
 * - A newer render aborts the older hydration: its late results are cached,
 *   never written into the page.
 *
 * Node-loadable like the rest of the view (test/markdown-mermaid.test.ts
 * runs it under jsdom with a fake renderer): relative `.ts` imports, every
 * DOM access through the root's own document.
 */
import type { MermaidRenderError, MermaidRenderResult } from "../../lib/mermaid-render.ts";
import { icon } from "../../mcp-app/icons.ts";
import { escapeText, type FenceRenderer } from "./render.ts";
import { createDiagramSanitizer, type Sanitize } from "./sanitize.ts";

/** lib/mermaid-render.ts' renderMermaid: source in, an SVG string or an error out */
export type RenderMermaid = (source: string, idPrefix: string) => Promise<MermaidRenderResult>;

/** the class of a mermaid fence's code block, the placeholder hydrate draws */
export const MERMAID_BLOCK_CLASS = "md-mermaid";
/** drawings kept by source: a long document's diagrams and their recent edits */
export const DRAWING_CACHE_SIZE = 64;
/** the drawn SVGs' id prefix: md- like every id of the view, and never a
 *  heading anchor (render.ts slugs are lower-case). mermaid starts a render
 *  by removing the element its id names, and scopes the diagram's styles to
 *  it: "md-mermaid-1" would take the heading "Mermaid 1" with it */
const ID_PREFIX = "md-Mermaid";

/** the notice's heading: a fence counts its lines from the diagram's first,
 *  not the document's */
const errorTitle = (error: MermaidRenderError): string =>
  error.line !== undefined ? `Error on line ${error.line} of the diagram` : "The diagram cannot be drawn";
/** the hint under the heading while the last good diagram stays in view */
const KEPT_LAST_GOOD = "The last version that rendered stays in view.";
/** the engine chunk did not load (offline, a stale deploy) */
const loadFailed = (e: unknown): MermaidRenderError => ({
  message: `The Mermaid renderer did not load: ${e instanceof Error ? e.message : String(e)}`,
});

/** what a block shows once settled: its last good drawing (a sanitized
 *  <svg>, cloned into the page), the error of its current source, or both */
interface Settled {
  drawing?: Element;
  error?: MermaidRenderError;
}

/** the window of the view's document */
type View = NonNullable<Document["defaultView"]>;

/** what one source draws as */
type Drawing = { svg: Element } | { error: MermaidRenderError };

export interface MermaidFence {
  render: FenceRenderer;
  hydrate(root: HTMLElement, signal: AbortSignal): Promise<void>;
}

const loadRenderer = async (): Promise<RenderMermaid> => (await import("../../lib/mermaid-render.ts")).renderMermaid;

/** `load` resolves the renderer; tests hand in a fake, the view the lazy chunk */
export function createMermaidFence(load: () => Promise<RenderMermaid> = loadRenderer): MermaidFence {
  const drawings = new Map<string, Drawing>(); // by source, least recently used first
  const inFlight = new Map<string, Promise<Drawing>>();
  const settledByView = new WeakMap<HTMLElement, Settled[]>();
  const sanitizers = new WeakMap<View, Sanitize>();

  const recall = (source: string): Drawing | undefined => {
    const known = drawings.get(source);
    if (known) {
      drawings.delete(source);
      drawings.set(source, known);
    }
    return known;
  };
  const remember = (source: string, drawing: Drawing): void => {
    drawings.delete(source);
    drawings.set(source, drawing);
    if (drawings.size > DRAWING_CACHE_SIZE) drawings.delete(drawings.keys().next().value!);
  };

  /** draw one source, once: a render already under way for it is shared.
   *  Rejects only when the engine does not load (that is not cached) */
  const draw = (render: RenderMermaid, source: string, win: View): Promise<Drawing> => {
    let pending = inFlight.get(source);
    if (!pending) {
      pending = render(source, ID_PREFIX)
        .then((result): Drawing => {
          let drawing: Drawing;
          if ("svg" in result) {
            let sanitize = sanitizers.get(win);
            if (!sanitize) sanitizers.set(win, (sanitize = createDiagramSanitizer(win)));
            const svg = sanitize(result.svg).firstElementChild;
            drawing = svg ? { svg } : { error: { message: "The diagram could not be drawn." } };
          } else drawing = { error: result.error };
          remember(source, drawing);
          return drawing;
        })
        .finally(() => inFlight.delete(source));
      inFlight.set(source, pending);
    }
    return pending;
  };

  return {
    render: (content) =>
      `<pre class="md-code ${MERMAID_BLOCK_CLASS}"><code class="language-mermaid">${escapeText(content)}</code></pre>\n`,

    async hydrate(root, signal) {
      const doc = root.ownerDocument;
      const win = doc.defaultView;
      if (!win) return;
      const blocks = [...root.querySelectorAll<HTMLElement>(`pre.${MERMAID_BLOCK_CLASS}`)];
      // the n-th block takes over what the n-th showed, unless a diagram was
      // added or removed: then the n-th is another diagram. A render without
      // a block (the view hydrates once more then) leaves nothing to take over
      const before = settledByView.get(root);
      const settled: Settled[] = blocks.map((_, i) => (before?.length === blocks.length ? before[i]! : {}));
      settledByView.set(root, settled);

      const show = (slot: HTMLElement, code: HTMLElement, index: number, drawing?: Drawing): void => {
        if (drawing && "svg" in drawing) settled[index] = { drawing: drawing.svg };
        else if (drawing) settled[index] = { drawing: settled[index]!.drawing, error: drawing.error };
        present(doc, slot, code, settled[index]!);
        if (drawing) slot.removeAttribute("aria-busy");
        else slot.setAttribute("aria-busy", "true");
      };

      // first, before the browser paints: every block drawn before, or kept
      // as it was while it draws anew
      const todo: Array<{ slot: HTMLElement; code: HTMLElement; index: number; source: string }> = [];
      blocks.forEach((code, index) => {
        const source = code.textContent ?? "";
        const slot = doc.createElement("div");
        slot.className = "md-mermaid-block";
        code.replaceWith(slot);
        const known = recall(source);
        show(slot, code, index, known);
        if (!known) todo.push({ slot, code, index, source });
      });
      if (todo.length === 0) return;

      let render: RenderMermaid;
      try {
        render = await load();
      } catch (e) {
        if (!signal.aborted) for (const t of todo) show(t.slot, t.code, t.index, { error: loadFailed(e) });
        return;
      }
      if (signal.aborted) return;
      await Promise.all(
        todo.map(async (t) => {
          const drawing = await draw(render, t.source, win).catch((e: unknown) => ({ error: loadFailed(e) }));
          if (!signal.aborted) show(t.slot, t.code, t.index, drawing);
        }),
      );
    },
  };
}

/** fill a block's slot with what it settled on */
function present(doc: Document, slot: HTMLElement, code: HTMLElement, settled: Settled): void {
  const parts: Node[] = [];
  if (settled.drawing) {
    const figure = doc.createElement("div");
    figure.className = settled.error ? "md-mermaid-diagram is-stale" : "md-mermaid-diagram";
    figure.append(doc.importNode(settled.drawing, true));
    parts.push(figure);
  } else parts.push(code);
  if (settled.error) parts.push(errorNotice(doc, settled.error, settled.drawing !== undefined));
  slot.replaceChildren(...parts);
}

/** the error notice under a block, in plain DOM */
function errorNotice(doc: Document, error: MermaidRenderError, keptLastGood: boolean): HTMLElement {
  const line = (className: string, text: string): HTMLElement => {
    const el = doc.createElement("div");
    el.className = className;
    el.textContent = text;
    return el;
  };
  const body = doc.createElement("div");
  body.className = "md-mermaid-notice-body";
  body.append(line("md-mermaid-notice-title", errorTitle(error)));
  if (keptLastGood) body.append(line("md-mermaid-notice-hint", KEPT_LAST_GOOD));
  // a parser's excerpt spans lines, its caret points at a column: mono
  const multiLine = error.message.includes("\n");
  body.append(line(multiLine ? "md-mermaid-notice-message is-mono" : "md-mermaid-notice-message", error.message));

  const notice = doc.createElement("div");
  notice.className = "md-mermaid-notice";
  notice.setAttribute("role", "status");
  notice.append(icon("circle-alert", 16, "md-mermaid-notice-icon", doc), body);
  return notice;
}
