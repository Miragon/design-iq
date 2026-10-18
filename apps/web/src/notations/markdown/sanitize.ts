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
 * own profile, instead of loosening this list for every document.
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
