/**
 * The Markdown view's second line of defence: DOMPurify against an allowlist
 * of exactly the markup ./render.ts emits, so a renderer slip can never hand
 * the page a script, a style, a form, an SVG or an event handler.
 *
 * Node-loadable on purpose (test/markdown-view.test.ts runs it under jsdom):
 * relative `.ts` imports, no "@/" alias, the window passed in.
 *
 * Widening it is a security decision: a fence extension that inserts richer
 * markup (a Mermaid SVG) sanitizes that output in its own `hydrate`, with its
 * own profile (createDiagramSanitizer below), instead of loosening this list
 * for every document.
 */
import DOMPurify, { type Config, type WindowLike } from "dompurify";

import { ANCHOR_PREFIX } from "./render.ts";

const SANITIZE: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  ALLOWED_ATTR: [
    "alt",
    "checked",
    "class",
    "data-model-path",
    "disabled",
    "href",
    "id",
    "loading",
    "referrerpolicy",
    "rel",
    "src",
    "start",
    "target",
    "title",
    "type",
  ],
  // the one data attribute is listed above: no other data-* gets through
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

/** HTML in, a sanitized fragment of the window's document out */
export type Sanitize = (html: string) => DocumentFragment;

export function createSanitizer(win: WindowLike): Sanitize {
  const purify = DOMPurify(win);
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("target")) {
      // a new tab is opened only without an opener and a referrer
      if (node.getAttribute("target") === "_blank") node.setAttribute("rel", "noopener noreferrer");
      else node.removeAttribute("target");
    }
    // task-list checkboxes are a picture of the state, never a control
    if (node.tagName === "INPUT") {
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
    }
    // the renderer's ids are heading anchors, all prefixed: any other id
    // could clobber a global (window.<id>) or an id of the app
    const id = node.getAttribute("id");
    if (id !== null && !id.startsWith(ANCHOR_PREFIX)) node.removeAttribute("id");
  });
  return (html) => purify.sanitize(html, SANITIZE);
}

/**
 * The profile for a diagram a fence extension draws (./mermaid-fence.ts):
 * the one mermaid applies to its own output under securityLevel "strict"
 * (DOMPurify's defaults plus the foreignObject its HTML labels sit in), run
 * once more on the page's side, minus forms and their controls, which act on
 * a click. The diagram reaches the view as a DOM node, never through
 * innerHTML: no script, no event handler, no javascript: URL. It keeps its
 * own <style>, which mermaid scopes to the SVG's id. A link in a diagram
 * opens a new tab without an opener, like every other link of the view that
 * leaves designIQ.
 *
 * And nothing in it loads once it is on the page (#293): mermaid lays the
 * diagram out in a frame that loads nothing (lib/mermaid-frame.ts), but the
 * SVG it returns still names what a label, a shape or a style asked for. An
 * element other than a link keeps an address only into the diagram (#…) or
 * to inline image data (C4 draws its people so), and CSS keeps no url() but
 * one into the diagram (inertCss).
 */
const DIAGRAM: Config & { RETURN_DOM_FRAGMENT: true } = {
  ADD_TAGS: ["foreignobject"],
  ADD_ATTR: ["dominant-baseline"],
  FORBID_TAGS: ["form", "button", "input", "select", "textarea"],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  RETURN_DOM_FRAGMENT: true,
};

/** an address that loads nothing: into the diagram itself, or inline image data */
const INERT_ADDRESS = /^\s*(?:#|data:image\/)/i;
/** the attributes a browser loads an address from */
const ADDRESS_ATTRIBUTES = [
  "src",
  "href",
  "xlink:href",
  "poster",
  "background",
  "data",
  "action",
  "formaction",
  "ping",
];
/** the attributes a browser reads as CSS, where a url() loads */
const CSS_ATTRIBUTES = [
  "style",
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
];
/** CSS that can name a resource without url(): an escape (it can spell
 *  url( itself), @import and the image functions that take a plain string */
const CSS_HIDES_RESOURCE = /\\|@import|image-set|image\(|cross-fade|element\(|src\(/i;
/** a url() to anything but the diagram itself; an unclosed one still loads */
const CSS_URL = /url\((?!\s*["']?\s*#)\s*(?:"[^"]*"?|'[^']*'?|[^)]*)\)?/gi;

/**
 * CSS that loads nothing: every url() that leaves the diagram becomes
 * `none`, so the rest of the rule still applies. CSS that could hide a
 * resource from that (CSS_HIDES_RESOURCE) is dropped whole: mermaid's own
 * CSS has none of it, so only a diagram's hostile styles lose their look.
 */
export function inertCss(css: string): string | undefined {
  return CSS_HIDES_RESOURCE.test(css) ? undefined : css.replace(CSS_URL, "none");
}

export function createDiagramSanitizer(win: WindowLike): Sanitize {
  const purify = DOMPurify(win);
  purify.addHook("afterSanitizeElements", (node) => {
    if (node.nodeName.toLowerCase() !== "style") return;
    const css = inertCss(node.textContent ?? "");
    if (css === undefined) node.parentNode?.removeChild(node);
    else if (css !== node.textContent) node.textContent = css;
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    const link = node.nodeName.toLowerCase() === "a";
    if (link) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    node.removeAttribute("srcset");
    for (const name of ADDRESS_ATTRIBUTES) {
      if (link && (name === "href" || name === "xlink:href")) continue;
      const value = node.getAttribute(name);
      if (value !== null && !INERT_ADDRESS.test(value)) node.removeAttribute(name);
    }
    for (const name of CSS_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (value === null) continue;
      const css = inertCss(value);
      if (css === undefined) node.removeAttribute(name);
      else if (css !== value) node.setAttribute(name, css);
    }
  });
  return (svg) => purify.sanitize(svg, DIAGRAM);
}
