/**
 * The script of the Mermaid frame (mermaid-frame.html): the app's one Mermaid
 * renderer (./mermaid-render.ts), loaded into the frame's own window, where
 * the page (./mermaid-frame.ts) calls it, with the page's global rules
 * (./mermaid-frame.css) to measure the labels under.
 */
import "./mermaid-frame.css";

import { MERMAID_FRAME_API, type MermaidFrameApi } from "./mermaid-frame.ts";
import { renderMermaid } from "./mermaid-render.ts";

const api: MermaidFrameApi = { render: renderMermaid };
Object.assign(window, { [MERMAID_FRAME_API]: api });
