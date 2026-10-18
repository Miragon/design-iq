/**
 * The Mermaid viewer's LAZY ENTRY, loaded by the manifest (./plugin.ts) on
 * mount: the viewer (./viewer.ts) with the Markdown view's mermaid fence it
 * draws through, and the stylesheet of both, as a chunk of their own. mermaid
 * itself loads behind lib/mermaid-render.ts' import() (ADR 0006).
 */
import "../markdown/markdown.css";

export { mountMermaidViewer } from "./viewer.ts";
