/**
 * The Markdown VIEW: the live document rendered read-only as formatted HTML
 * in the canvas layer. Editing stays in the shell's Monaco source layer, one
 * click away; every change to the shared Y.Text, a collaborator's included,
 * re-renders the view after a short debounce.
 *
 * The HTML comes from ./render.ts (raw HTML already escaped there) and is
 * sanitized again (./sanitize.ts) before it reaches the page. Links to other
 * models of the repository navigate inside designIQ through the shell;
 * #anchors scroll this view.
 *
 * Node-loadable on purpose (test/markdown-view.test.ts runs it under jsdom):
 * relative `.ts` imports, and every DOM access goes through the container's
 * own document and window. The stylesheet comes with the lazy entry,
 * ./markdown-view.ts.
 *
 * Every render replaces the whole article. Simple and correct, but a reader's
 * text selection and keyboard focus inside the view reset whenever a
 * co-editor pauses typing: patching only the changed blocks is a follow-up.
 */
import type { EditorContext, MountedEditor } from "../registry.ts";
import { FENCE_EXTENSIONS, type FenceExtension } from "./fences.ts";
import { anchorId, type FenceRenderer, renderMarkdown, safeDecode } from "./render.ts";
import { createSanitizer } from "./sanitize.ts";

/** a co-editor typing must not re-render on every keystroke ... */
export const RENDER_DEBOUNCE_MS = 200;
/** ... but a steady stream of changes (a fast typist, a streaming agent)
 *  still shows at least once a second */
export const RENDER_MAX_WAIT_MS = 1000;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function mountMarkdownView(
  container: HTMLElement,
  ctx: EditorContext,
  fences: Readonly<Record<string, FenceExtension>> = FENCE_EXTENSIONS,
): MountedEditor {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("The Markdown view needs a document with a window");
  const sanitize = createSanitizer(win);

  const scroller = doc.createElement("div");
  scroller.className = "markdown-view";
  // a scrollable region is reachable by keyboard (arrow keys, Page Down)
  scroller.tabIndex = 0;
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", "Document preview");
  const article = doc.createElement("article");
  article.className = "markdown-body";
  scroller.append(article);
  container.append(scroller);

  let lastSource: string | undefined;
  let lastModels: ReadonlySet<string> | undefined;
  let rendered = false;
  let hydration: AbortController | undefined;

  const render = (): void => {
    const source = ctx.ytext.toString();
    const models = ctx.models?.paths();
    if (source === lastSource && models === lastModels) return;
    // the fence languages this document has: only their extensions hydrate,
    // so a diagram engine loads only for a document that contains a diagram
    const seen = new Set<string>();
    const renderers: Record<string, FenceRenderer> = {};
    for (const [lang, extension] of Object.entries(fences)) {
      renderers[lang] = (content, info) => {
        seen.add(lang);
        return extension.render(content, info);
      };
    }
    let html: string;
    try {
      html = renderMarkdown(source, { repo: ctx.repo, docPath: ctx.docPath, fences: renderers, models });
    } catch (e) {
      // the first render failing sends the shell to the source view; a later
      // one keeps the last good rendering on screen
      if (rendered) ctx.onSyncError(`The preview could not be updated: ${errorText(e)}`);
      else ctx.onImportFailed(errorText(e));
      return;
    }
    lastSource = source;
    lastModels = models;
    rendered = true;
    hydration?.abort();
    hydration = undefined;
    if (source.trim() === "") {
      const empty = doc.createElement("p");
      empty.className = "md-empty";
      empty.textContent = "This document is empty. Switch to Markdown to write it.";
      article.replaceChildren(empty);
      return;
    }
    article.replaceChildren(sanitize(html));
    if (seen.size === 0) return;
    hydration = new AbortController();
    const signal = hydration.signal;
    for (const lang of seen) {
      Promise.resolve()
        .then(() => fences[lang]?.hydrate?.(article, signal))
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
      const heading = doc.getElementById(anchorId(candidate));
      if (heading && article.contains(heading)) return void heading.scrollIntoView({ block: "start" });
    }
  };

  // plain left clicks only: a modified or middle click opens the link's real
  // href in a new tab, which is the same route on a full page load
  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target instanceof win.Element ? e.target.closest("a[href]") : null;
    if (!(link instanceof win.HTMLAnchorElement) || !article.contains(link)) return;
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
  if (win.location.hash.length > 1) scrollToFragment(win.location.hash.slice(1));

  // trailing debounce with a maximum wait
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingSince: number | undefined;
  const flush = (): void => {
    timer = undefined;
    pendingSince = undefined;
    render();
  };
  const onChange = (): void => {
    const now = Date.now();
    pendingSince ??= now;
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(RENDER_DEBOUNCE_MS, pendingSince + RENDER_MAX_WAIT_MS - now)));
  };
  ctx.ytext.observe(onChange);
  // the model list arrived or changed: links to models re-classify
  const offModels = ctx.models?.onChange(render);

  return {
    destroy: () => {
      clearTimeout(timer);
      ctx.ytext.unobserve(onChange);
      offModels?.();
      hydration?.abort();
      article.removeEventListener("click", onClick);
      scroller.remove();
    },
  };
}
