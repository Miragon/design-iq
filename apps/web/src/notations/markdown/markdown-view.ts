/**
 * The Markdown VIEW: the live document rendered read-only as formatted HTML
 * in the canvas layer, loaded on demand by the manifest (./plugin.ts) as
 * its own chunk (markdown-it, DOMPurify, this module and its stylesheet).
 * Editing stays in the shell's Monaco source layer, one click away; every
 * change to the shared Y.Text, a collaborator's included, re-renders the
 * view after a short debounce.
 *
 * The HTML comes from ./render.ts (raw HTML already escaped there) and is
 * sanitized again here, against an allowlist of exactly what the renderer
 * emits, before it reaches the page. Links to other models of the repository
 * navigate inside designIQ through the shell; #anchors scroll this view.
 */
import "./markdown.css";

import DOMPurify, { type Config } from "dompurify";

import type { EditorContext, MountedEditor } from "../registry";
import { FENCE_EXTENSIONS } from "./fences";
import { anchorId, type FenceRenderer, renderMarkdown, safeDecode } from "./render";

/** a co-editor typing must not re-render on every keystroke */
const RENDER_DEBOUNCE_MS = 200;

/** exactly the markup ./render.ts produces: defense in depth, so a renderer
 *  slip can never hand the page a script, a style, a form or an event handler */
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

const purify = DOMPurify(window);
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("target")) {
    // a new tab is opened only without an opener and a referrer
    if (node.getAttribute("target") === "_blank") node.setAttribute("rel", "noopener noreferrer");
    else node.removeAttribute("target");
  }
  // task-list checkboxes are a picture of the state, never a control
  if (node.tagName === "INPUT") node.setAttribute("disabled", "");
});

const FENCE_RENDERERS: Readonly<Record<string, FenceRenderer>> = Object.fromEntries(
  Object.entries(FENCE_EXTENSIONS).map(([lang, extension]) => [lang, extension.render]),
);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function mountMarkdownView(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const scroller = document.createElement("div");
  scroller.className = "markdown-view";
  // a scrollable region is reachable by keyboard (arrow keys, Page Down)
  scroller.tabIndex = 0;
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", "Document preview");
  const article = document.createElement("article");
  article.className = "markdown-body";
  scroller.append(article);
  container.append(scroller);

  let lastSource: string | undefined;
  let rendered = false;
  let hydration: AbortController | undefined;

  const render = (): void => {
    const source = ctx.ytext.toString();
    if (source === lastSource) return;
    let html: string;
    try {
      html = renderMarkdown(source, { repo: ctx.repo, docPath: ctx.docPath, fences: FENCE_RENDERERS });
    } catch (e) {
      // the first render failing sends the shell to the source view; a later
      // one keeps the last good rendering on screen
      if (rendered) ctx.onSyncError(`The preview could not be updated: ${errorText(e)}`);
      else ctx.onImportFailed(errorText(e));
      return;
    }
    lastSource = source;
    rendered = true;
    hydration?.abort();
    if (source.trim() === "") {
      const empty = document.createElement("p");
      empty.className = "md-empty";
      empty.textContent = "This document is empty. Switch to Markdown to write it.";
      article.replaceChildren(empty);
      return;
    }
    article.replaceChildren(purify.sanitize(html, SANITIZE));
    hydration = new AbortController();
    for (const [lang, extension] of Object.entries(FENCE_EXTENSIONS)) {
      const signal = hydration.signal;
      Promise.resolve()
        .then(() => extension.hydrate?.(article, signal))
        .catch((e: unknown) => {
          if (!signal.aborted) ctx.onSyncError(`A ${lang} block could not be rendered: ${errorText(e)}`);
        });
    }
  };

  /** scroll to a heading by its URL fragment (bare slug, maybe percent-encoded) */
  const scrollToFragment = (raw: string): void => {
    const fragment = safeDecode(raw);
    if (fragment === "") return void scroller.scrollTo({ top: 0 });
    for (const candidate of new Set([fragment, fragment.toLowerCase()])) {
      const heading = document.getElementById(anchorId(candidate));
      if (heading && article.contains(heading)) return void heading.scrollIntoView({ block: "start" });
    }
  };

  // plain left clicks only: a modified or middle click opens the link's real
  // href in a new tab, which is the same route on a full page load
  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!(link instanceof HTMLAnchorElement) || !article.contains(link)) return;
    const href = link.getAttribute("href") ?? "";
    const modelPath = link.dataset.modelPath;
    if (modelPath !== undefined) {
      if (!ctx.onOpenModel) return; // no shell navigation: the browser follows the href
      e.preventDefault();
      const hashAt = href.indexOf("#");
      ctx.onOpenModel(modelPath, hashAt < 0 ? "" : safeDecode(href.slice(hashAt + 1)));
    } else if (href.startsWith("#")) {
      e.preventDefault();
      scrollToFragment(href.slice(1));
    }
  };
  article.addEventListener("click", onClick);

  render();
  // opened through a link with a #section: land on it
  if (location.hash.length > 1) scrollToFragment(location.hash.slice(1));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = (): void => {
    clearTimeout(timer);
    timer = setTimeout(render, RENDER_DEBOUNCE_MS);
  };
  ctx.ytext.observe(onChange);

  return {
    destroy: () => {
      clearTimeout(timer);
      ctx.ytext.unobserve(onChange);
      hydration?.abort();
      article.removeEventListener("click", onClick);
      scroller.remove();
    },
  };
}
