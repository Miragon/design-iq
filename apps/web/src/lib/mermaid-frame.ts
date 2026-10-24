/**
 * mermaid in a frame of its own (#293). mermaid lays a diagram out in the
 * document it runs in: it puts the diagram's labels, links and styles into a
 * temporary node there, measures them, and sanitizes the SVG only after. In
 * the page's document that node would load the diagram's images and style
 * sheets with every reader's address, and hold its links as written,
 * `javascript:` included (a kanban ticket link, a state diagram's click), in
 * the reader's session. So mermaid runs in a hidden frame
 * (mermaid-frame.html) whose policy lets nothing load or run but designIQ's
 * own scripts, styles and fonts, and the page only ever gets the SVG as a
 * string, which it sanitizes once more before drawing it
 * (notations/markdown/sanitize.ts).
 *
 * The frame is same-origin, so the page calls the renderer in it directly
 * and the frame loads the app's own chunks. Its document is the build's
 * mermaid-frame.html set as `srcdoc`: the Live Host forbids framing any of
 * its responses (frame-ancestors 'none'), and a srcdoc is none.
 *
 * Loaded through import() like the renderer it stands for (ADR 0006); the
 * frame, and mermaid in it, load on the first diagram a document draws.
 */
import type { MermaidRenderResult } from "./mermaid-render.ts";

/** where the frame's script puts the renderer on the frame's window */
export const MERMAID_FRAME_API = "designiqMermaid";
/** the frame's document as the build emits it */
export const MERMAID_FRAME_URL = "/mermaid-frame.html";
/** what tells the frame's document from the app's index.html, which the
 *  Live Host answers an unknown path with (an older build without the frame):
 *  that app must never boot in the frame */
export const MERMAID_FRAME_MARKER = '<meta name="designiq-frame" content="mermaid"';

/** the renderer the frame's window carries */
export interface MermaidFrameApi {
  render(source: string, idPrefix: string): Promise<MermaidRenderResult>;
}

/** the renderer the page calls: the frame's, laid out `width` CSS pixels
 *  wide, the page's body when it names none */
export type RenderMermaid = (source: string, idPrefix: string, width?: number) => Promise<MermaidRenderResult>;

/** a frame that has started: its element in the page and its renderer */
export interface MermaidFrame {
  element: HTMLIFrameElement;
  api: MermaidFrameApi;
}

/** the frame's document as HTML; rejects when it is not the frame's */
export async function fetchFrameHtml(): Promise<string> {
  const response = await fetch(MERMAID_FRAME_URL, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`${MERMAID_FRAME_URL} answered ${response.status}`);
  const html = await response.text();
  if (!html.includes(MERMAID_FRAME_MARKER)) throw new Error(`${MERMAID_FRAME_URL} is not the Mermaid frame`);
  return html;
}

/**
 * Start a frame in `doc`: hidden, out of the tab order and of the
 * accessibility tree. Each render sets its width, because a Gantt chart
 * takes its width from the element it is drawn in. No sandbox attribute: the
 * frame needs scripts and the page's origin, and a frame allowed both can
 * lift its own sandbox, so the policy in its document is the guard.
 */
export async function openMermaidFrame(doc: Document, html: string): Promise<MermaidFrame> {
  const element = doc.createElement("iframe");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("tabindex", "-1");
  element.title = "Mermaid layout";
  Object.assign(element.style, {
    position: "fixed",
    top: "0",
    left: "-100000px",
    height: "100vh",
    border: "0",
    visibility: "hidden",
    pointerEvents: "none",
  });
  element.srcdoc = html;
  const loaded = new Promise<void>((resolve) => element.addEventListener("load", () => resolve(), { once: true }));
  doc.body.append(element);
  await loaded;
  const api = (element.contentWindow as (Window & { [MERMAID_FRAME_API]?: MermaidFrameApi }) | null)?.[
    MERMAID_FRAME_API
  ];
  if (!api) {
    element.remove();
    throw new Error("The Mermaid frame did not start.");
  }
  return { element, api };
}

export interface MermaidFrameOptions {
  /** the page's document */
  doc?: Document;
  /** starts the frame; tests hand in a frame of their own */
  open?: (doc: Document) => Promise<MermaidFrame>;
}

/**
 * renderMermaid behind the frame: the same source in, the same SVG string or
 * error out. ONE frame for the page, started on the first call and shared;
 * a frame that fails to start (offline, a stale deploy) rejects like a failed
 * engine load, and the next call starts another.
 */
export function createMermaidFrameRenderer(options: MermaidFrameOptions = {}): RenderMermaid {
  const open = options.open ?? (async (doc: Document) => openMermaidFrame(doc, await fetchFrameHtml()));
  let frame: Promise<MermaidFrame> | undefined;
  const started = (doc: Document): Promise<MermaidFrame> => {
    if (!frame) {
      frame = open(doc);
      frame.catch(() => {
        frame = undefined;
      });
    }
    return frame;
  };
  return async (source, idPrefix, width) => {
    const doc = options.doc ?? document;
    let current = await started(doc);
    if (!current.element.isConnected) {
      frame = undefined;
      current = await started(doc);
    }
    current.element.style.width = `${width ?? doc.body.clientWidth}px`;
    return current.api.render(source, idPrefix);
  };
}

/** the app's renderer: the one frame of the page */
export const renderMermaidInFrame: RenderMermaid = createMermaidFrameRenderer();
