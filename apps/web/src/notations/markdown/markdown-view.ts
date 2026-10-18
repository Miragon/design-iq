/**
 * The Markdown view's LAZY ENTRY, loaded by the manifest (./plugin.ts) on
 * mount: the view (./view.ts) with markdown-it and DOMPurify, and its
 * stylesheet, as one chunk of their own. The eager bundle carries none of
 * them (ADR 0006; `pnpm arch` holds every other module to `import()`).
 */
import "./markdown.css";

export { mountMarkdownView } from "./view.ts";
