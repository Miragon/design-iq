/**
 * ```mermaid fences in the Markdown view, drawn as diagrams: the first entry
 * of the fence extension point (./fences.ts), on the app's one Mermaid
 * renderer (lib/mermaid-render.ts: strict security level, the CI theme,
 * Geist), which lays every diagram out in a frame of its own
 * (lib/mermaid-frame.ts); the page only gets the SVG, sanitized here once
 * more (createDiagramSanitizer).
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
 *   removed), so a live edit never flashes a diagram back to code. One
 *   drawing is never in two places, which would put each of its ids on the
 *   page twice (#294): a source the document shows twice is drawn twice,
 *   each block of it keeps its own drawing while another is edited, and a
 *   block whose last drawing another block now shows waits for its new one
 *   with its code.
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
import type { RenderMermaid } from "../../lib/mermaid-frame.ts";
import type { MermaidRenderError } from "../../lib/mermaid-render.ts";
import { icon } from "../../mcp-app/icons.ts";
import { escapeText, type FenceRenderer } from "./render.ts";
import { createDiagramSanitizer, type Sanitize } from "./sanitize.ts";

/** lib/mermaid-render.ts' renderMermaid, through the frame: source in, an SVG string or an error out */
export type { RenderMermaid };

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

const loadRenderer = async (): Promise<RenderMermaid> =>
  (await import("../../lib/mermaid-frame.ts")).renderMermaidInFrame;

/** what a drawing is cached by: its source, and which of that source's drawings it is (a source two fences show has two) */
const drawingKey = (source: string, repeat: number): string => `${repeat}:${source}`;

/** `load` resolves the renderer; tests hand in a fake, the view the lazy chunk */
export function createMermaidFence(load: () => Promise<RenderMermaid> = loadRenderer): MermaidFence {
  const drawings = new Map<string, Drawing>(); // by drawingKey, least recently used first
  const inFlight = new Map<string, Promise<Drawing>>();
  const settledByView = new WeakMap<HTMLElement, Settled[]>();
  const sanitizers = new WeakMap<View, Sanitize>();
  /** the source a drawing shows, and which of that source's drawings it is */
  const origins = new WeakMap<Element, { source: string; repeat: number }>();

  const recall = (key: string): Drawing | undefined => {
    const known = drawings.get(key);
    if (known) {
      drawings.delete(key);
      drawings.set(key, known);
    }
    return known;
  };
  const remember = (key: string, drawing: Drawing): void => {
    drawings.delete(key);
    drawings.set(key, drawing);
    if (drawings.size > DRAWING_CACHE_SIZE) drawings.delete(drawings.keys().next().value!);
  };

  /** draw one of a source's drawings, once: a render already under way for
   *  it is shared. Rejects only when the engine does not load (that is not
   *  cached) */
  const draw = (render: RenderMermaid, source: string, repeat: number, win: View): Promise<Drawing> => {
    const key = drawingKey(source, repeat);
    let pending = inFlight.get(key);
    if (!pending) {
      pending = render(source, ID_PREFIX)
        .then((result): Drawing => {
          let drawing: Drawing;
          if ("svg" in result) {
            let sanitize = sanitizers.get(win);
            if (!sanitize) sanitizers.set(win, (sanitize = createDiagramSanitizer(win)));
            const svg = sanitize(result.svg).firstElementChild;
            if (svg) origins.set(svg, { source, repeat });
            drawing = svg ? { svg } : { error: { message: "The diagram could not be drawn." } };
          } else drawing = { error: result.error };
          remember(key, drawing);
          return drawing;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
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

      // which of its source's drawings a block takes: the one it shows
      // already, else the first no other block takes
      const sources = blocks.map((code) => code.textContent ?? "");
      const taken = new Map<string, Set<number>>();
      const takenOf = (source: string): Set<number> => {
        let repeats = taken.get(source);
        if (!repeats) taken.set(source, (repeats = new Set()));
        return repeats;
      };
      const shownAlready = sources.map((source, index) => {
        const kept = settled[index]!.drawing;
        const origin = kept && origins.get(kept);
        if (!origin || origin.source !== source || takenOf(source).has(origin.repeat)) return undefined;
        takenOf(source).add(origin.repeat);
        return origin.repeat;
      });
      const entries = blocks.map((code, index) => {
        const source = sources[index]!;
        let repeat = shownAlready[index];
        if (repeat === undefined) {
          for (repeat = 0; takenOf(source).has(repeat); repeat++);
          takenOf(source).add(repeat);
        }
        return { code, index, source, repeat, known: recall(drawingKey(source, repeat)) };
      });

      // a block without a drawing of its own keeps its last one, unless
      // another block shows that one now
      const placed = new Set<Element>();
      for (const { known } of entries) if (known && "svg" in known) placed.add(known.svg);
      for (const { index, known } of entries) {
        const kept = settled[index]!.drawing;
        if (!kept || (known && "svg" in known)) continue;
        if (placed.has(kept)) settled[index] = { error: settled[index]!.error };
        else placed.add(kept);
      }

      // first, before the browser paints: every block drawn before, or kept
      // as it was while it draws anew
      const todo: Array<{ slot: HTMLElement; code: HTMLElement; index: number; source: string; repeat: number }> = [];
      for (const { code, index, source, repeat, known } of entries) {
        const slot = doc.createElement("div");
        slot.className = "md-mermaid-block";
        code.replaceWith(slot);
        show(slot, code, index, known);
        if (!known) todo.push({ slot, code, index, source, repeat });
      }
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
          const drawing = await draw(render, t.source, t.repeat, win).catch((e: unknown) => ({ error: loadFailed(e) }));
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
