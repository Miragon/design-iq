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

import { CSS_RESOURCE } from "../../lib/css-resource.ts";
import { ANCHOR_PREFIX } from "./render.ts";

const SANITIZE: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: [
    "a",
    "blockquote",
    "br",
    "button",
    "code",
    "del",
    "details",
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
    "kbd",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "section",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
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
    "open",
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
    // the renderer's ids are heading and footnote anchors, all prefixed: any
    // other id could clobber a global (window.<id>) or an id of the app
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
 * And nothing in it loads once it is on the page (#290, #293): mermaid lays
 * the diagram out in a frame that loads nothing (lib/mermaid-frame.ts), but
 * the SVG it returns still names what a label, a shape or a style asked for.
 * An element other than a link keeps an address only to this diagram (#…)
 * or to inline image data (C4 draws its people so), and an attribute or a
 * style sheet whose CSS could name any other resource is dropped. Parsed, the
 * SVG decodes entities a style sheet kept as text while mermaid drew it, so
 * what the page would apply is checked here, not only the source
 * (lib/mermaid-render.ts).
 */
const DIAGRAM: Config & { RETURN_DOM_FRAGMENT: true } = {
  ADD_TAGS: ["foreignobject"],
  ADD_ATTR: ["dominant-baseline"],
  FORBID_TAGS: ["form", "button", "input", "select", "textarea"],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  RETURN_DOM_FRAGMENT: true,
};

/** an address inside the diagram or inline data: nothing to fetch */
const LOCAL_REFERENCE = /^\s*(?:#|data:image\/)/i;
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

export function createDiagramSanitizer(win: WindowLike): Sanitize {
  const purify = DOMPurify(win);
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
      if (value !== null && !LOCAL_REFERENCE.test(value)) node.removeAttribute(name);
    }
    // a presentation attribute (stroke, fill, mask, filter …) is CSS as much as a style is
    for (const { name, value } of [...node.attributes]) {
      if (link && (name === "href" || name === "xlink:href")) continue;
      if (CSS_RESOURCE.test(value)) node.removeAttribute(name);
    }
    if (node.nodeName.toLowerCase() === "style" && CSS_RESOURCE.test(node.textContent ?? "")) node.remove();
  });
  return (svg) => {
    const fragment = purify.sanitize(svg, DIAGRAM);
    for (const drawing of fragment.children) scopeIds(drawing);
    return fragment;
  };
}

/** a url() that names an element of the diagram */
const URL_REFERENCE = /url\(\s*(["']?)#([^"')\s]+)\1\s*\)/g;
/** the attributes that name elements of the diagram as a list of ids */
const ID_LISTS = new Set(["aria-labelledby", "aria-describedby"]);

/**
 * Every id in a drawn diagram starts with its SVG's id, and each is there
 * once (#294). mermaid scopes most ids with the render id, which names the
 * SVG, but not all: a sequence diagram's actors, an architecture diagram's
 * services (named by the author), a sankey's gradients and a treemap's clip
 * paths keep ids of their own, and a mindmap writes a node's id on its
 * shape a second time. Two diagrams on one page, or a diagram and the app,
 * would share an id, and a url(#…), a label or an anchor would find another
 * element. Such an id gets the SVG's id as a prefix and every reference
 * within the SVG follows it; an id seen before in the SVG is dropped, so
 * the first element keeps it, the one a reference expects. A reference to
 * an id the SVG does not hold gets the prefix too, so it can never reach an
 * element outside the diagram: a vertical timeline points its lines at
 * #arrowhead, an id mermaid never writes. A link's #… is where a reader
 * goes, a heading of the document say, and keeps its target.
 */
function scopeIds(svg: Element): void {
  const own = svg.id;
  const isScoped = (id: string): boolean => !own || (id.startsWith(own) && !/^[A-Za-z0-9]/.test(id.slice(own.length)));
  const renamed = new Map<string, string>();
  const seen = new Set([own]);
  for (const element of svg.querySelectorAll("[id]")) {
    const id = element.id;
    const scoped = isScoped(id) ? id : `${own}-${id}`;
    if (seen.has(scoped)) {
      element.removeAttribute("id");
      continue;
    }
    seen.add(scoped);
    if (scoped !== id) {
      element.id = scoped;
      if (!renamed.has(id)) renamed.set(id, scoped);
    }
  }
  const follow = (id: string): string => renamed.get(id) ?? (isScoped(id) ? id : `${own}-${id}`);
  const followUrls = (text: string): string =>
    text.replace(URL_REFERENCE, (_url, quote: string, id: string) => `url(${quote}#${follow(id)}${quote})`);
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    const link = element.localName === "a";
    for (const { name, value } of [...element.attributes]) {
      let next = followUrls(value);
      if ((name === "href" || name === "xlink:href") && value.startsWith("#")) {
        const id = value.slice(1);
        next = `#${link ? (renamed.get(id) ?? id) : follow(id)}`;
      }
      if (ID_LISTS.has(name)) next = value.split(/\s+/).map(follow).join(" ");
      if (next !== value) element.setAttribute(name, next);
    }
    if (element.localName === "style") element.textContent = followUrls(element.textContent ?? "");
  }
}
