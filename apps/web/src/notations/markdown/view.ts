/**
 * The Markdown VIEW: the live document rendered read-only as formatted HTML
 * in the canvas layer. Editing stays in the shell's Monaco source layer, one
 * click away or beside the view (the split view); every change to the shared
 * Y.Text, a collaborator's included, re-renders the view after a short
 * debounce.
 *
 * The HTML comes from ./render.ts (raw HTML already escaped there, but for
 * GitHub's small subset, written anew) and is sanitized again (./sanitize.ts)
 * before it reaches the page; the view's own icons, which the sanitizer
 * admits no SVG for, go in after it (withIcons). Links to other models of the
 * repository navigate inside designIQ through the shell; #anchors scroll this
 * view.
 *
 * An image from another site shows as a placeholder until the reader loads
 * it: that choice holds for this view of the document, through every
 * re-render, and is never stored. A repository image that does not load (a
 * missing file, one too large) turns into a placeholder and stays one.
 *
 * Node-loadable on purpose (test/markdown-view.test.ts runs it under jsdom):
 * relative `.ts` imports, and every DOM access goes through the container's
 * own document and window. The stylesheet comes with the lazy entry,
 * ./markdown-view.ts.
 *
 * A render patches the article per top-level block (#289): a block whose
 * rendered HTML did not change stays on the page as it is, with the reader's
 * text selection, the keyboard focus and a drawn diagram in it, and the
 * others are replaced. matchBlocks aligns the blocks of the two renders, so a
 * block that repeats (a heading's text, a rule) never costs an unchanged
 * block its place. A block that moved past others counts as changed, and so
 * does a heading whose id a new heading with the same text renumbered. The
 * focus in a replaced block moves to the view itself, so the keyboard stays
 * in it. The reader's place stays too: the first block on screen stays where
 * it is on screen, across a render (once the fences have put their cached
 * output back) and after it, when a diagram drawn or an image loaded above it
 * changes the article's height. A block the top of the view cuts holds the
 * place by its end, so what follows it stays put when its own height changes.
 * A browser's CSS scroll anchoring often did that already, and then nothing
 * is left to move; Safari has it only from 27 on, so the view does not rely
 * on it.
 * While the shell shows only the source (ctx.visibility), the view does not
 * render at all, not even a document that opens that way, and catches up
 * when it shows again: an author typing in Monaco never pays for a hidden
 * document's diagrams.
 */
import { icon } from "../../mcp-app/icons.ts";
import type { EditorContext, MountedEditor } from "../registry.ts";
import { FENCE_EXTENSIONS, type FenceExtension } from "./fences.ts";
import { anchorId, type FenceRenderer, renderMarkdown, type RepoWeb, safeDecode } from "./render.ts";
import { createSanitizer } from "./sanitize.ts";

/** a co-editor typing must not re-render on every keystroke ... */
export const RENDER_DEBOUNCE_MS = 200;
/** ... but a steady stream of changes (a fast typist, a streaming agent)
 *  still shows at least once a second */
export const RENDER_MAX_WAIT_MS = 1000;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** what a top-level node of the article rendered as: an element's markup
 *  before any fence hydrated it, any other node's text */
const blockKey = (node: Node): string =>
  node.nodeType === node.ELEMENT_NODE ? (node as Element).outerHTML : `#${node.nodeName} ${node.textContent ?? ""}`;
const isElementKey = (key: string): boolean => key.startsWith("<");

/** a stretch of the old blocks, [oldStart, oldEnd), and of the new ones, [newStart, newEnd) */
interface Stretch {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** the largest stretch (old blocks times new ones) aligned block by block
 *  when no block in it is unique; a larger one is replaced */
const MAX_ALIGNED_CELLS = 1 << 18;

/**
 * Which blocks of the last render the next one keeps: for each new block, the
 * index of the old block it is (the same key, in the same order), or -1 for
 * one to insert. A patience alignment: the common start and end match first.
 * In between, the blocks whose key occurs once on each side anchor the match,
 * as many of them as keep their order, and each stretch between two anchors
 * is matched the same way. So a key that repeats (a heading's text, a rule,
 * the line breaks between blocks) never pulls the match past a block that
 * could stay. A stretch without such a block is aligned block by block (the
 * longest common subsequence, a block outweighing every line break).
 */
export function matchBlocks(before: readonly string[], after: readonly string[]): number[] {
  const kept = after.map(() => -1);
  const stretches: Stretch[] = [{ oldStart: 0, oldEnd: before.length, newStart: 0, newEnd: after.length }];
  for (let stretch = stretches.pop(); stretch; stretch = stretches.pop()) {
    let { oldStart, oldEnd, newStart, newEnd } = stretch;
    while (oldStart < oldEnd && newStart < newEnd && before[oldStart] === after[newStart])
      kept[newStart++] = oldStart++;
    while (oldStart < oldEnd && newStart < newEnd && before[oldEnd - 1] === after[newEnd - 1])
      kept[--newEnd] = --oldEnd;
    if (oldStart === oldEnd || newStart === newEnd) continue;
    const anchors = uniqueAnchors(before, after, { oldStart, oldEnd, newStart, newEnd });
    if (anchors.length === 0) {
      alignRepeated(before, after, { oldStart, oldEnd, newStart, newEnd }, kept);
      continue;
    }
    for (const [oldAt, newAt] of anchors) {
      kept[newAt] = oldAt;
      stretches.push({ oldStart, oldEnd: oldAt, newStart, newEnd: newAt });
      oldStart = oldAt + 1;
      newStart = newAt + 1;
    }
    stretches.push({ oldStart, oldEnd, newStart, newEnd });
  }
  return kept;
}

/** the blocks (elements) whose key occurs once in the stretch on each side,
 *  as [old index, new index], cut down to the longest run in the same order */
function uniqueAnchors(before: readonly string[], after: readonly string[], stretch: Stretch): Array<[number, number]> {
  const once = (keys: readonly string[], start: number, end: number): Map<string, number> => {
    const index = new Map<string, number>();
    for (let at = start; at < end; at++) {
      const key = keys[at]!;
      if (isElementKey(key)) index.set(key, index.has(key) ? -1 : at);
    }
    return index;
  };
  const oldOnce = once(before, stretch.oldStart, stretch.oldEnd);
  const pairs: Array<[number, number]> = [];
  for (const [key, newAt] of once(after, stretch.newStart, stretch.newEnd)) {
    const oldAt = oldOnce.get(key) ?? -1;
    if (newAt >= 0 && oldAt >= 0) pairs.push([oldAt, newAt]);
  }
  // patience sorting: tails[n] is the pair that ends the lowest run of n + 1
  const tails: number[] = [];
  const previous: number[] = [];
  pairs.forEach(([oldAt], pair) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]!]![0] < oldAt) low = middle + 1;
      else high = middle;
    }
    previous[pair] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = pair;
  });
  const run: Array<[number, number]> = [];
  for (let pair = tails.at(-1) ?? -1; pair >= 0; pair = previous[pair]!) run.push(pairs[pair]!);
  return run.reverse();
}

/** match a stretch in which no block is unique by the longest common
 *  subsequence of its keys, a block weighing more than all its line breaks */
function alignRepeated(before: readonly string[], after: readonly string[], stretch: Stretch, kept: number[]): void {
  const rows = stretch.oldEnd - stretch.oldStart;
  const columns = stretch.newEnd - stretch.newStart;
  if (rows * columns > MAX_ALIGNED_CELLS) return;
  const weight = (key: string): number => (isElementKey(key) ? rows + columns + 1 : 1);
  const same = (row: number, column: number): boolean =>
    before[stretch.oldStart + row] === after[stretch.newStart + column];
  const width = columns + 1;
  /** best[row * width + column]: the most weight the rest of the stretch from there matches */
  const best = new Int32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      const cell = row * width + column;
      const match = same(row, column) ? best[cell + width + 1]! + weight(before[stretch.oldStart + row]!) : 0;
      best[cell] = Math.max(best[cell + width]!, best[cell + 1]!, match);
    }
  }
  for (let row = 0, column = 0; row < rows && column < columns;) {
    const cell = row * width + column;
    if (same(row, column) && best[cell] === best[cell + width + 1]! + weight(before[stretch.oldStart + row]!)) {
      kept[stretch.newStart + column++] = stretch.oldStart + row++;
    } else if (best[cell] === best[cell + width]) row++;
    else column++;
  }
}

export function mountMarkdownView(
  container: HTMLElement,
  ctx: EditorContext,
  fences: Readonly<Record<string, FenceExtension>> = FENCE_EXTENSIONS,
): MountedEditor {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("The Markdown view needs a document with a window");
  /** the addresses of the images from other sites the reader loaded */
  const externalImages = new Set<string>();
  /** the routes of the repository images that did not load */
  const brokenImages = new Set<string>();
  const sanitizeDocument = createSanitizer(win, { externalImages });
  const sanitize = (html: string): DocumentFragment => withIcons(sanitizeDocument(html), doc);

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
  let lastWeb: RepoWeb | undefined;
  /** counts the images the reader loaded: a render with a new one is not a repeat */
  let imagesLoaded = 0;
  let lastImagesLoaded = 0;
  let rendered = false;
  let hydration: AbortController | undefined;
  /** the fence languages the last render hydrated */
  let hydrated = new Set<string>();
  /** the keys of the article's top-level nodes as the last render put them
   *  there; undefined while it shows no rendered document */
  let blockKeys: string[] | undefined;
  /** where the reader is: the first block on screen, which of its edges
   *  holds the place, where that edge was on screen, and the scroll offset
   *  then */
  let place: { block: Element; edge: "top" | "bottom"; at: number; scrollTop: number } | undefined;

  /** the first of these blocks on screen, and where it is. None at the top
   *  of the document: a reader there stays at the top */
  const readingPlace = (blocks: ArrayLike<Element>): typeof place => {
    const scrollTop = scroller.scrollTop;
    if (scrollTop <= 0) return undefined;
    const view = scroller.getBoundingClientRect();
    // the blocks stack down the page: the first one that ends below the top
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (blocks[middle]!.getBoundingClientRect().bottom > view.top) high = middle;
      else low = middle + 1;
    }
    const block = blocks[low];
    if (!block) return undefined;
    const box = block.getBoundingClientRect();
    // a block the top of the view cuts and that ends on screen: the reader
    // reads what follows it, which stays put when the block's own height
    // changes later (a diagram drawn in it, an image loaded)
    const edge = box.top < view.top && box.bottom <= view.bottom ? "bottom" : "top";
    return { block, edge, at: box[edge], scrollTop };
  };

  /** scroll the reader's place back to where it was, and take it anew. Not
   *  when the reader scrolled since, nor the browser: its CSS scroll
   *  anchoring did it then */
  const keepPlace = (): void => {
    if (place?.block.isConnected && scroller.scrollTop === place.scrollTop) {
      const shift = place.block.getBoundingClientRect()[place.edge] - place.at;
      if (shift !== 0) scroller.scrollTop += shift;
    }
    place = readingPlace(article.children);
  };
  const onScroll = (): void => {
    if (scroller.scrollTop !== place?.scrollTop) place = readingPlace(article.children);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  // what lands after a render, a diagram drawn or an image loaded above the
  // reader, changes the article's height: the reader stays where they were
  const resizes = "ResizeObserver" in win ? new win.ResizeObserver(() => keepPlace()) : undefined;
  resizes?.observe(article);

  /** show a rendered document: the blocks the last render showed as they
   *  are, the others new */
  const patch = (fragment: DocumentFragment): void => {
    const next = [...fragment.childNodes];
    const nextKeys = next.map(blockKey);
    const current = [...article.childNodes];
    // the article's blocks are not the last render's (the empty document, or
    // a fence extension that added or removed one): start over
    if (blockKeys?.length !== current.length) {
      article.replaceChildren(fragment);
      blockKeys = nextKeys;
      return;
    }
    const kept = matchBlocks(blockKeys, nextKeys);
    const keep = new Set(kept.filter((at) => at >= 0));
    // settle what moved since the last frame; the reader's block may be one
    // this render replaces, then the first block on screen that stays holds
    // the place
    keepPlace();
    const staying = [...keep].map((at) => current[at]!).filter((node) => node instanceof win.Element);
    if (place && !staying.includes(place.block)) place = readingPlace(staying);
    current.forEach((node, at) => {
      if (!keep.has(at)) node.remove();
    });
    let before: ChildNode | null = null;
    for (let i = next.length - 1; i >= 0; i--) {
      const at = kept[i]!;
      if (at >= 0) before = current[at]!;
      else before = article.insertBefore(next[i]!, before);
    }
    blockKeys = nextKeys;
  };

  const render = (): void => {
    const source = ctx.ytext.toString();
    const models = ctx.models?.paths();
    const web = ctx.repoWeb?.get();
    const repeat = source === lastSource && models === lastModels && web === lastWeb;
    if (repeat && imagesLoaded === lastImagesLoaded) return;
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
      html = renderMarkdown(source, {
        repo: ctx.repo,
        docPath: ctx.docPath,
        repoWeb: web,
        fences: renderers,
        models,
        externalImages,
        brokenImages,
      });
    } catch (e) {
      // the first render failing sends the shell to the source view; a later
      // one keeps the last good rendering on screen
      if (rendered) ctx.onSyncError(`The preview could not be updated: ${errorText(e)}`);
      else ctx.onImportFailed(errorText(e));
      return;
    }
    lastSource = source;
    lastModels = models;
    lastWeb = web;
    lastImagesLoaded = imagesLoaded;
    rendered = true;
    hydration?.abort();
    hydration = new AbortController();
    const signal = hydration.signal;
    const focused = doc.activeElement;
    const focusInside = focused !== null && article.contains(focused);
    if (source.trim() === "") {
      const empty = doc.createElement("p");
      empty.className = "md-empty";
      // true beside the source (the split view) as much as one click from it
      empty.textContent = "This document is empty. Write it in the Markdown source.";
      article.replaceChildren(empty);
      blockKeys = undefined;
    } else {
      patch(sanitize(html));
    }
    // the focus was in a block that went: keep the keyboard in the view
    if (focusInside && !article.contains(focused)) scroller.focus({ preventScroll: true });
    // this document's fence languages, and once more the ones the last
    // render had: with no block left, their extension forgets this document
    const languages = new Set([...seen, ...hydrated]);
    hydrated = seen;
    for (const lang of languages) {
      Promise.resolve()
        .then(() => fences[lang]?.hydrate?.(article, signal))
        .catch((e: unknown) => {
          if (!signal.aborted) ctx.onSyncError(`A ${lang} block could not be rendered: ${errorText(e)}`);
        });
    }
    // queued after the hydrations: their synchronous part, the cached output,
    // is back by then
    void Promise.resolve().then(() => {
      if (!signal.aborted) keepPlace();
    });
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

  /** the reader asked for an image from another site; its block re-renders
   *  with the image, and a focus on its button moves to the view */
  const loadImage = (button: HTMLButtonElement): void => {
    const url = button.dataset.imageSrc ?? "";
    if (!/^https:\/\//i.test(url)) return;
    externalImages.add(url);
    imagesLoaded++;
    update();
  };

  // plain left clicks only: a modified or middle click opens the link's real
  // href in a new tab, which is the same route on a full page load
  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented) return;
    const button = e.target instanceof win.Element ? e.target.closest("button.md-image-load") : null;
    if (button instanceof win.HTMLButtonElement && article.contains(button)) {
      e.preventDefault();
      return loadImage(button);
    }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
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
      // the address names the section, so it can be shared, as on GitHub;
      // replaced, not pushed: no history entry per click, no hashchange.
      // TanStack Router's history wraps replaceState, so the router hears of
      // the new address and renders the route again, its state kept. Its own
      // scroll to the bare fragment stays off: it would find an element of
      // the app, never the view's md- prefixed anchor
      const at = href === "#" ? win.location.pathname + win.location.search : href;
      win.history.replaceState({ ...win.history.state, __hashScrollIntoViewOptions: false }, "", at);
    }
  };
  article.addEventListener("click", onClick);

  // a repository image that does not load becomes the placeholder it would
  // have rendered as, now and in every later render; error does not bubble
  const onImageError = (e: Event): void => {
    const image = e.target;
    if (!(image instanceof win.HTMLImageElement) || !image.classList.contains("md-repo-image")) return;
    const route = image.getAttribute("src");
    if (!route || !article.contains(image)) return;
    brokenImages.add(route);
    const path = new URL(route, win.location.href).searchParams.get("path") ?? route;
    const placeholder = doc.createElement("span");
    placeholder.className = "md-image-placeholder";
    placeholder.title = path;
    placeholder.textContent = `Image not shown: ${image.alt || path.split("/").pop() || "image"}`;
    image.replaceWith(placeholder);
  };
  article.addEventListener("error", onImageError, true);

  // opened through a link with a #section: land on it once the document is
  // on screen
  let landing = win.location.hash.length > 1 ? win.location.hash.slice(1) : undefined;
  // hidden behind the source layer: a change only marks the view behind, and
  // it renders once it shows again. So does the first render of a document
  // that opens on its source (the view switch remembers it)
  const hidden = (): boolean => ctx.visibility?.visible() === false;
  let behind = false;
  const update = (): void => {
    if (hidden()) {
      behind = true;
      return;
    }
    behind = false;
    render();
    if (landing !== undefined && rendered) {
      scrollToFragment(landing);
      landing = undefined;
    }
  };
  update();

  // trailing debounce with a maximum wait
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingSince: number | undefined;
  const flush = (): void => {
    timer = undefined;
    pendingSince = undefined;
    update();
  };
  const onChange = (): void => {
    if (hidden()) {
      behind = true;
      return;
    }
    const now = Date.now();
    pendingSince ??= now;
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(RENDER_DEBOUNCE_MS, pendingSince + RENDER_MAX_WAIT_MS - now)));
  };
  ctx.ytext.observe(onChange);
  // the model list arrived or changed: links to models re-classify
  const offModels = ctx.models?.onChange(update);
  // the repository's GitHub address arrived or changed: links to it re-classify
  const offWeb = ctx.repoWeb?.onChange(update);
  const offVisibility = ctx.visibility?.onChange(() => {
    if (behind && !hidden()) update();
  });

  return {
    destroy: () => {
      clearTimeout(timer);
      ctx.ytext.unobserve(onChange);
      offModels?.();
      offWeb?.();
      offVisibility?.();
      hydration?.abort();
      resizes?.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      article.removeEventListener("click", onClick);
      article.removeEventListener("error", onImageError, true);
      scroller.remove();
    },
  };
}

/** the view's icons in a sanitized document: a Lucide chevron in place of the
 *  browser's disclosure triangle, in the summary of every <details> */
function withIcons(fragment: DocumentFragment, doc: Document): DocumentFragment {
  for (const summary of fragment.querySelectorAll("details > summary:first-of-type")) {
    summary.prepend(icon("chevron-right", 16, "md-summary-icon", doc));
  }
  return fragment;
}
