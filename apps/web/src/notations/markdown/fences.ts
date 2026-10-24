/**
 * The fence extension point of the Markdown view, keyed by language: a fenced
 * code block whose language has an entry here renders through it, every other
 * fence stays a plain code block. One entry so far: ```mermaid fences draw as
 * diagrams (./mermaid-fence.ts). Another renderer plugs in as one more entry,
 * and the view needs no change for it.
 *
 * `render` runs synchronously inside the Markdown render and returns HTML,
 * sanitized with the rest of the document (./sanitize.ts: markup, never
 * script). An engine that needs the DOM or draws asynchronously (Mermaid does
 * both) renders a placeholder there and upgrades it in `hydrate`.
 *
 * The contract an extension builds on:
 * - `hydrate` runs after a render when that document has a fence of its
 *   language, with the document root, and once more after the first render
 *   that has none (no block then): drop what was kept for the document
 *   there. Load the engine in `hydrate` for a block, behind `import()`, never
 *   at the top of this module: the fences load with every Markdown document
 *   (ADR 0006).
 * - A placeholder carries its source as TEXT (`<pre class="md-mermaid">`
 *   with the escaped source). The sanitizer drops every data-* attribute but
 *   data-model-path, and admits no style and no SVG.
 * - Whatever `hydrate` inserts is its own to sanitize, with its own profile.
 * - A render patches the document per top-level block (./view.ts): a block
 *   whose rendered HTML did not change stays on the page as it is, with what
 *   `hydrate` made of its placeholder; only the changed and new blocks come
 *   new, with a fresh placeholder. So the root `hydrate` gets holds both:
 *   upgrade each placeholder once, leave an upgraded one that is done as it
 *   is (never wrap or draw it twice), and finish one an aborted `hydrate`
 *   left unfinished.
 * - Upgrade a placeholder in place: replacing it with one node is fine, but
 *   never add or remove a node elsewhere in the root. The view finds the
 *   blocks it keeps by their position among the root's children; once their
 *   count is off, the next render replaces the whole document, and the
 *   reader's selection with it.
 * - Every render aborts the previous `signal`. Cache the drawn output by
 *   source, so a new block with a diagram drawn before (an undo, an edit
 *   elsewhere in its list) does not draw it again, and put it back in the
 *   synchronous part of `hydrate`, before the first `await`: the view calls
 *   `hydrate` in a microtask right after the render, so what is back by then
 *   is on screen without a flash of code, and the reader's scroll position
 *   is restored after it.
 */
import { createMermaidFence } from "./mermaid-fence.ts";
import type { FenceRenderer } from "./render.ts";

export interface FenceExtension {
  render: FenceRenderer;
  hydrate?(root: HTMLElement, signal: AbortSignal): void | Promise<void>;
}

/** language (lower-case, the fence's first info word) → its extension */
export const FENCE_EXTENSIONS: Readonly<Record<string, FenceExtension>> = {
  mermaid: createMermaidFence(),
};
