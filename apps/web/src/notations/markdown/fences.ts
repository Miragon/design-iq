/**
 * The fence extension point of the Markdown view, keyed by language: a fenced
 * code block whose language has an entry here renders through it, every other
 * fence stays a plain code block. Empty in this release (a ```mermaid fence
 * shows its source); a diagram renderer plugs in as one entry, and the view
 * needs no change for it.
 *
 * `render` runs synchronously inside the Markdown render and returns HTML,
 * sanitized with the rest of the document (./sanitize.ts: markup, never
 * script). An engine that needs the DOM or draws asynchronously (Mermaid does
 * both) renders a placeholder there and upgrades it in `hydrate`.
 *
 * The contract an extension builds on:
 * - `hydrate` runs after a render only when that document has a fence of its
 *   language, with the document root. Load the engine there, behind
 *   `import()`, never at the top of this module: the fences load with every
 *   Markdown document (ADR 0006).
 * - A placeholder carries its source as TEXT (`<pre class="md-mermaid">`
 *   with the escaped source). The sanitizer drops every data-* attribute but
 *   data-model-path, and admits no style and no SVG.
 * - Whatever `hydrate` inserts is its own to sanitize, with its own profile.
 * - Every render replaces the whole document, placeholders included, and
 *   aborts the previous `signal`. Cache the drawn output by source, so a
 *   document re-rendered for an edit elsewhere does not draw every diagram
 *   again.
 */
import type { FenceRenderer } from "./render.ts";

export interface FenceExtension {
  render: FenceRenderer;
  hydrate?(root: HTMLElement, signal: AbortSignal): void | Promise<void>;
}

/** language (lower-case, the fence's first info word) → its extension */
export const FENCE_EXTENSIONS: Readonly<Record<string, FenceExtension>> = {};
