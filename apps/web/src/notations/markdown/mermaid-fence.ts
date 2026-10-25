/**
 * ```mermaid fences in the Markdown view, drawn as diagrams: the first entry
 * of the fence extension point (./fences.ts), on the app's one Mermaid
 * renderer (lib/mermaid-render.ts: strict security level, the CI theme,
 * Geist), which lays every diagram out in a frame of its own
 * (lib/mermaid-frame.ts); the page only gets the SVG, sanitized here once
 * more (createDiagramSanitizer). A diagram is laid out at its block's width;
 * drawn, it shrinks to its block only as far as its smallest text stays
 * readable, and scrolls sideways beyond that (./diagram-scale.ts).
 *
 * - `render` (the HTML pass) keeps the fence a code block, marked
 *   `md-mermaid`, with its source as text: what a reader sees until the
 *   diagram is drawn, and what stays when it cannot be.
 * - `hydrate` (the DOM) puts every such block into a slot of its own
 *   (`md-mermaid-block`) and draws it there, once. The view keeps a block a
 *   render did not change, slot and drawing included (./fences.ts): a slot
 *   that shows its source's drawing stays as it is, and only new blocks and
 *   a slot an aborted hydration left drawing are drawn. The renderer, and
 *   mermaid behind it, load here, so only a document with a mermaid fence
 *   fetches them (ADR 0006).
 * - Drawings are cached by source: a new block with a diagram drawn before
 *   (an edit elsewhere in its list or quote, an undo) gets it back before
 *   the browser paints, and only a changed diagram is drawn again. Until it
 *   is, the new block shows what the one it replaced showed (the n-th
 *   diagram takes over the n-th one's drawing while no diagram is added or
 *   removed), so a live edit never flashes a diagram back to code.
 * - A source mermaid cannot read gets a notice (the error and its line)
 *   under the block's last good drawing, dimmed, or under its code when it
 *   never drew.
 * - A newer render aborts the older hydration: its late results are cached,
 *   never written into the page by it. The newer one picks up a slot the
 *   view kept and draws into it.
 *
 * Node-loadable like the rest of the view (test/markdown-mermaid.test.ts
 * runs it under jsdom with a fake renderer): relative `.ts` imports, every
 * DOM access through the root's own document.
 */
import type { RenderMermaid } from "../../lib/mermaid-frame.ts";
import type { MermaidRenderError, MermaidRenderResult } from "../../lib/mermaid-render.ts";
import { icon } from "../../mcp-app/icons.ts";
import {
  DIAGRAM_CLASS,
  fitDiagramSlot,
  followBlockWidth,
  refitWidth,
  type Relayout,
  takesItsWidth,
} from "./diagram-scale.ts";
import { escapeText, type FenceRenderer } from "./render.ts";
import { createDiagramSanitizer, type Sanitize } from "./sanitize.ts";

/** lib/mermaid-render.ts' renderMermaid, through the frame: source in, an SVG string or an error out */
export type { RenderMermaid };

/** the class of a mermaid fence's code block, the placeholder hydrate draws */
export const MERMAID_BLOCK_CLASS = "md-mermaid";
/** the class of the slot hydrate puts that block in, where it draws */
const SLOT_CLASS = "md-mermaid-block";
/** drawings kept by source: a long document's diagrams and their recent edits */
export const DRAWING_CACHE_SIZE = 64;
/** drawings laid out anew for another block width, kept by width and source:
 *  the same source in a quote and outside it, a column back at a width it had */
const RELAYOUT_CACHE_SIZE = 16;
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

/** a diagram block on the page, by its slot */
interface Block {
  source: string;
  /** the fence's code block: what the slot shows while it has no drawing */
  code: HTMLElement;
  settled: Settled;
  /** the slot shows what its source draws as; not while that is drawn, nor
   *  after the renderer did not load (the next hydration tries again) */
  done: boolean;
}

/** the window of the view's document */
type View = NonNullable<Document["defaultView"]>;

/** what one source draws as */
type Drawing = { svg: Element } | { error: MermaidRenderError };

export interface MermaidFence {
  render: FenceRenderer;
  hydrate(root: HTMLElement, signal: AbortSignal): Promise<void>;
}

/** the width mermaid lays a diagram out at: its own block's, which a Gantt
 *  chart takes as its own width. A block in a list or a quote is narrower
 *  than the column. Undefined while the view is not laid out (the frame
 *  takes the page's width then) */
const layoutWidth = (block: HTMLElement): number | undefined => (block.clientWidth > 0 ? block.clientWidth : undefined);

const loadRenderer = async (): Promise<RenderMermaid> =>
  (await import("../../lib/mermaid-frame.ts")).renderMermaidInFrame;

/** `load` resolves the renderer; tests hand in a fake, the view the lazy chunk */
export function createMermaidFence(load: () => Promise<RenderMermaid> = loadRenderer): MermaidFence {
  const drawings = new Map<string, Drawing>(); // by source, least recently used first
  const inFlight = new Map<string, Promise<Drawing>>();
  /** what each slot on a page shows, and for which source */
  const blocks = new WeakMap<HTMLElement, Block>();
  /** a document's slots in order, as its last hydration left them */
  const slotsByView = new WeakMap<HTMLElement, HTMLElement[]>();
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

  const drawingOf = (result: MermaidRenderResult, win: View): Drawing => {
    if (!("svg" in result)) return { error: result.error };
    let sanitize = sanitizers.get(win);
    if (!sanitize) sanitizers.set(win, (sanitize = createDiagramSanitizer(win)));
    const svg = sanitize(result.svg).firstElementChild;
    return svg ? { svg } : { error: { message: "The diagram could not be drawn." } };
  };

  /** laid out at its block's width, and once more, narrower, when it took
   *  that width as its own and its text would hold it wider. Such a drawing
   *  is laid out anew whenever its block changes width (./diagram-scale.ts) */
  const layOut = async (render: RenderMermaid, source: string, win: View, block: HTMLElement): Promise<Drawing> => {
    const width = layoutWidth(block);
    const drawing = drawingOf(await render(source, ID_PREFIX, width), win);
    if (width === undefined || !("svg" in drawing) || !takesItsWidth(drawing.svg, width)) return drawing;
    const refit = refitWidth(drawing.svg, width, block);
    const refitted = refit === undefined ? drawing : drawingOf(await render(source, ID_PREFIX, refit), win);
    const fitted = "svg" in refitted ? refitted : drawing;
    followBlockWidth(fitted.svg, width, relayoutOf(render, source, win));
    return fitted;
  };

  const relaidOut = new Map<string, Promise<Drawing>>(); // by width and source, least recently used first
  /** the source laid out for its block's width now, and kept as its drawing */
  const relayoutOf =
    (render: RenderMermaid, source: string, win: View): Relayout =>
    async (block) => {
      const width = layoutWidth(block);
      if (width === undefined) return undefined;
      const key = `${width}\n${source}`;
      const pending = relaidOut.get(key) ?? layOut(render, source, win, block);
      relaidOut.delete(key);
      relaidOut.set(key, pending);
      if (relaidOut.size > RELAYOUT_CACHE_SIZE) relaidOut.delete(relaidOut.keys().next().value!);
      let drawing: Drawing;
      try {
        drawing = await pending;
      } catch {
        // the engine did not load: not kept, the next change of width tries again
        relaidOut.delete(key);
        return undefined;
      }
      if (!("svg" in drawing)) return undefined;
      remember(source, drawing);
      return drawing.svg;
    };

  /** draw one source, once: a render already under way for it is shared.
   *  Rejects only when the engine does not load (that is not cached) */
  const draw = (render: RenderMermaid, source: string, win: View, block: HTMLElement): Promise<Drawing> => {
    let pending = inFlight.get(source);
    if (!pending) {
      pending = layOut(render, source, win, block)
        .then((drawing) => {
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
      // a newer render came first: its own hydration sees this one's blocks
      if (signal.aborted) return;
      const doc = root.ownerDocument;
      const win = doc.defaultView;
      if (!win) return;
      // every diagram of the document in order: the slot of a block the view
      // kept, or the code block of a new one (a slot without a drawing shows
      // its code: that one is the slot's)
      const found = [...root.querySelectorAll<HTMLElement>(`.${SLOT_CLASS}, pre.${MERMAID_BLOCK_CLASS}`)].filter(
        (el) => !el.parentElement?.closest(`.${SLOT_CLASS}`),
      );
      const before = slotsByView.get(root) ?? [];

      const show = (slot: HTMLElement, block: Block, drawing?: Drawing, done = drawing !== undefined): void => {
        if (drawing && "svg" in drawing) block.settled = { drawing: drawing.svg };
        else if (drawing) block.settled = { drawing: block.settled.drawing, error: drawing.error };
        block.done = done;
        present(doc, slot, block.code, block.settled);
        if (drawing) slot.removeAttribute("aria-busy");
        else slot.setAttribute("aria-busy", "true");
      };

      // first, before the browser paints: every new block drawn before, or
      // showing what the one it replaced showed while it draws anew
      const slots: HTMLElement[] = [];
      const todo: HTMLElement[] = [];
      found.forEach((el, index) => {
        let slot = el;
        let block = blocks.get(el);
        if (!block) {
          if (!el.matches(`pre.${MERMAID_BLOCK_CLASS}`)) return;
          slot = doc.createElement("div");
          slot.className = SLOT_CLASS;
          el.replaceWith(slot);
          // the n-th diagram takes over what the n-th showed when that one
          // left the page with this render, unless a diagram was added or
          // removed: then the n-th is another diagram. A render without a
          // diagram leaves nothing to take over
          const replaced = found.length === before.length ? before[index] : undefined;
          const settled = replaced && !replaced.isConnected ? blocks.get(replaced)?.settled : undefined;
          block = { source: el.textContent ?? "", code: el, settled: settled ?? {}, done: false };
          blocks.set(slot, block);
          const known = recall(block.source);
          show(slot, block, known);
          if (!known) todo.push(slot);
        } else if (!block.done) {
          // kept while it was drawn, or the renderer did not load: draw it now
          const known = recall(block.source);
          if (known) show(slot, block, known);
          else {
            slot.setAttribute("aria-busy", "true");
            todo.push(slot);
          }
        }
        slots.push(slot);
      });
      if (slots.length > 0) slotsByView.set(root, slots);
      else slotsByView.delete(root);
      if (todo.length === 0) return;

      let render: RenderMermaid;
      try {
        render = await load();
      } catch (e) {
        if (!signal.aborted) for (const slot of todo) show(slot, blocks.get(slot)!, { error: loadFailed(e) }, false);
        return;
      }
      if (signal.aborted) return;
      await Promise.all(
        todo.map(async (slot) => {
          const block = blocks.get(slot)!;
          let drawing: Drawing;
          let done = true;
          try {
            drawing = await draw(render, block.source, win, slot);
          } catch (e) {
            drawing = { error: loadFailed(e) };
            done = false;
          }
          if (!signal.aborted) show(slot, block, drawing, done);
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
    figure.className = settled.error ? `${DIAGRAM_CLASS} is-stale` : DIAGRAM_CLASS;
    figure.append(doc.importNode(settled.drawing, true));
    parts.push(figure);
  } else parts.push(code);
  if (settled.error) parts.push(errorNotice(doc, settled.error, settled.drawing !== undefined));
  slot.replaceChildren(...parts);
  fitDiagramSlot(slot, settled.drawing);
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
