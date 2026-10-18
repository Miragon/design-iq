/**
 * The fence extension point of the Markdown view, keyed by language: a fenced
 * code block whose language has an entry here renders through it, every other
 * fence stays a plain code block. Empty in this release (a ```mermaid fence
 * shows its source); a diagram renderer plugs in as one entry, and the view
 * needs no change for it.
 *
 * `render` runs synchronously inside the Markdown render and returns HTML,
 * sanitized with the rest of the document (markup, never script). An engine
 * that needs the DOM or draws asynchronously (Mermaid does both) renders a
 * placeholder there and upgrades it in `hydrate`, which the view calls after
 * every render with the document root. The signal aborts when the next render
 * replaces that DOM or the view closes; whatever `hydrate` inserts is its own
 * to sanitize.
 */
import type { FenceRenderer } from "./render";

export interface FenceExtension {
  render: FenceRenderer;
  hydrate?(root: HTMLElement, signal: AbortSignal): void | Promise<void>;
}

/** language (lower-case, the fence's first info word) → its extension */
export const FENCE_EXTENSIONS: Readonly<Record<string, FenceExtension>> = {};
