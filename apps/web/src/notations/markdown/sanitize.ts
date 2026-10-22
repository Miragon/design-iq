/**
 * The Markdown view's second line of defence: DOMPurify against an allowlist
 * of exactly the markup ./render.ts emits, so a renderer slip can never hand
 * the page a script, a style, a form, an SVG or an event handler.
 *
 * Node-loadable on purpose (test/markdown-view.test.ts runs it under jsdom):
 * relative `.ts` imports, no "@/" alias, the window passed in.
 *
 * It also holds the view to its image rule (./render.ts): an image loads
 * from the page's own origin or inline data, or from another site the reader
 * chose to load. A slip that names any other address loses it here, so no
 * reader's browser calls a third party unasked.
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
    "button",
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
    "data-image-src",
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
  // the two data attributes are listed above: no other data-* gets through
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

/** HTML in, a sanitized fragment of the window's document out */
export type Sanitize = (html: string) => DocumentFragment;

/** the window the view renders in: DOMPurify's, and the page's address */
export type SanitizeWindow = WindowLike & { location: { href: string; origin: string } };

export interface SanitizeOptions {
  /** the addresses of the images from other sites the reader chose to load */
  externalImages?: ReadonlySet<string>;
}

export function createSanitizer(win: SanitizeWindow, options: SanitizeOptions = {}): Sanitize {
  const purify = DOMPurify(win);
  const loadsUnasked = (src: string): boolean => {
    if (/^data:image\//i.test(src)) return true;
    try {
      return new URL(src, win.location.href).origin === win.location.origin;
    } catch {
      return false;
    }
  };
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src");
      if (src !== null && !loadsUnasked(src)) {
        if (options.externalImages?.has(src)) node.setAttribute("referrerpolicy", "no-referrer");
        else node.removeAttribute("src");
      }
    }
    // a button of the view acts through its click handler, never submits
    if (node.tagName === "BUTTON") node.setAttribute("type", "button");
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
 * exactly the one mermaid applies to its own output under securityLevel
 * "strict" (DOMPurify's defaults plus the foreignObject its HTML labels sit
 * in), run once more on the page's side. The diagram reaches the view as a
 * DOM node, never through innerHTML: no script, no event handler, no
 * javascript: URL. It keeps its own <style>, which mermaid scopes to the
 * SVG's id. A link in a diagram opens a new tab without an opener, like
 * every other link of the view that leaves designIQ. And nothing in it loads
 * from another site once it is on the page (#290): an element other than a
 * link keeps an address only to this diagram (#…) or to inline data, and a
 * style attribute that names any other resource is dropped.
 */
const DIAGRAM: Config & { RETURN_DOM_FRAGMENT: true } = {
  ADD_TAGS: ["foreignobject"],
  ADD_ATTR: ["dominant-baseline"],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  RETURN_DOM_FRAGMENT: true,
};

/** an address inside the diagram or inline data: nothing to fetch */
const LOCAL_REFERENCE = /^\s*(?:#|data:image\/)/i;
/** CSS that could name a resource: a url() not to this diagram, image-set(), @import, or an escape hiding one */
const CSS_RESOURCE = /url\(\s*(?!["']?\s*#)|image-set|@import|\\/i;

export function createDiagramSanitizer(win: WindowLike): Sanitize {
  const purify = DOMPurify(win);
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName.toLowerCase() === "a") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    } else {
      for (const name of ["src", "srcset", "href", "xlink:href"]) {
        const value = node.getAttribute(name);
        if (value !== null && (name === "srcset" || !LOCAL_REFERENCE.test(value))) node.removeAttribute(name);
      }
    }
    if (CSS_RESOURCE.test(node.getAttribute("style") ?? "")) node.removeAttribute("style");
  });
  return (svg) => purify.sanitize(svg, DIAGRAM);
}
