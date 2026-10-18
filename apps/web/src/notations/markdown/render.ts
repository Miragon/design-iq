/**
 * The Markdown view's renderer, PURE: Markdown source in, an HTML string out.
 * markdown-it renders CommonMark plus the GFM extensions the content repos
 * use (tables, strikethrough, task lists, autolinks) and gives every heading
 * an anchor. The DOM side (sanitizing, mounting, clicks, scrolling) is
 * ./markdown-view.ts.
 *
 * Node-loadable on purpose (test/markdown-render.test.ts): relative `.ts`
 * imports, no "@/" alias, nothing DOM-bound.
 *
 * Content-repo Markdown is untrusted. Raw HTML is escaped, never passed
 * through (`html: false`, and the two html render rules escape as well);
 * markdown-it's validateLink keeps javascript:, vbscript:, file: and
 * non-image data: URLs from becoming a link or an image; the view sanitizes
 * the result once more (DOMPurify) before it reaches the page.
 *
 * Links between models: a relative link resolves against the document's
 * folder (a leading "/" against the repository root, as on GitHub). A target
 * with a registered notation extension becomes its in-app route; any other
 * repository file (a folder, an image, source code) is not something
 * designIQ opens, so it renders as plain, marked text instead of a link that
 * would lead nowhere.
 */
import { byExtension } from "@designiq/notations";
import MarkdownIt, { type Env, type StateCore, type Token } from "markdown-it";

/** the language and the full info string of a fenced code block */
export interface FenceInfo {
  /** first word of the info string, lower-case ("" for a bare fence) */
  lang: string;
  /** the whole info string, unescaped and trimmed */
  info: string;
}

/**
 * The fence-renderer hook, keyed by language: the HTML for one fenced block,
 * or undefined to keep the default code block. Its output is sanitized with
 * the rest of the document, so it is HTML markup, never script.
 */
export type FenceRenderer = (content: string, info: FenceInfo) => string | undefined;

export interface RenderOptions {
  /** repository full name, "owner/name": builds the routes of linked models */
  repo: string;
  /** repo-relative path of the rendered document: relative links resolve against its folder */
  docPath: string;
  /** fence renderers by language (lower-case); a language without one renders as code */
  fences?: Readonly<Record<string, FenceRenderer>>;
}

/** what a link in the document points at */
export type LinkTarget =
  /** a section of this document */
  | { kind: "anchor"; fragment: string }
  /** another model of the repository: opens inside designIQ */
  | { kind: "model"; path: string; fragment: string }
  /** a repository file designIQ does not open, or a path above the repository root (path undefined) */
  | { kind: "file"; path: string | undefined }
  /** a web address: opens in a new tab */
  | { kind: "external" }
  /** any other scheme markdown-it lets through (mailto:, tel:): left to the browser */
  | { kind: "other" };

/** heading ids carry a prefix, so document content can never clobber a
 *  global (window.<id>) or another id of the app; URL fragments stay bare
 *  GitHub-style slugs and map onto it */
export const ANCHOR_PREFIX = "md-";

/** the element id of a heading slug */
export const anchorId = (slug: string): string => `${ANCHOR_PREFIX}${slug}`;

/** GitHub's heading slug: lower-case, punctuation dropped, spaces to hyphens */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** the in-app route of a model, the file route of src/router.tsx (/r/$owner/$repo/f/$) */
export function modelRoute(repo: string, path: string, fragment = ""): string {
  const [owner = "", name = ""] = repo.split("/");
  const segments = path.split("/").map(encodeURIComponent).join("/");
  const hash = fragment ? `#${encodeURIComponent(fragment)}` : "";
  return `/r/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/f/${segments}${hash}`;
}

/** decodeURIComponent that keeps malformed input as it is */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve `href` (a link target as markdown-it normalized it, so
 * percent-encoded) against the folder of `docPath`, a repo-relative path.
 * Returns the repo-relative target path, or undefined when the path climbs
 * above the repository root.
 */
export function resolveRepoPath(href: string, docPath: string): string | undefined {
  const base = href.startsWith("/") ? [] : docPath.split("/").slice(0, -1);
  const out = [...base];
  for (const segment of safeDecode(href).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(segment);
  }
  // a trailing slash names a folder: keep it, so it never reads as a file
  return out.join("/") + (href.endsWith("/") && out.length > 0 ? "/" : "");
}

/** where a link of the document at `docPath` points */
export function classifyHref(href: string, docPath: string): LinkTarget {
  if (href.startsWith("//") || /^https?:/i.test(href)) return { kind: "external" };
  if (SCHEME.test(href)) return { kind: "other" };
  const hashAt = href.indexOf("#");
  const fragment = hashAt < 0 ? "" : safeDecode(href.slice(hashAt + 1));
  const pathPart = (hashAt < 0 ? href : href.slice(0, hashAt)).replace(/\?.*$/, "");
  if (pathPart === "") return { kind: "anchor", fragment };
  const path = resolveRepoPath(pathPart, docPath);
  if (path === undefined) return { kind: "file", path: undefined };
  if (path === docPath) return { kind: "anchor", fragment };
  if (!path.endsWith("/") && byExtension(path)) return { kind: "model", path, fragment };
  return { kind: "file", path };
}

/** what the core rules read from markdown-it's env */
interface RenderEnv extends Env {
  repo: string;
  docPath: string;
  fences: Readonly<Record<string, FenceRenderer>>;
}

const TASK_MARKER = /^\[([ xX])\](?:[ \t]+|$)/;

/** GFM task lists: a list item whose text starts with "[ ]" or "[x]" gets a
 *  read-only checkbox, its list the class that drops the bullets */
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i]!;
    const item = tokens[i - 2]!;
    if (inline.type !== "inline" || tokens[i - 1]!.type !== "paragraph_open" || item.type !== "list_item_open") {
      continue;
    }
    const first = inline.children?.[0];
    const match = first?.type === "text" ? TASK_MARKER.exec(first.content) : null;
    if (!first || !match) continue;
    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token("task_checkbox", "input", 0);
    checkbox.meta = { checked: match[1] !== " " };
    inline.children!.unshift(checkbox);
    item.attrJoin("class", "task-list-item");
    for (let j = i - 3; j >= 0; j--) {
      const list = tokens[j]!;
      if (list.nesting === 1 && list.level === item.level - 1) {
        if (list.type === "bullet_list_open" || list.type === "ordered_list_open") {
          if (!String(list.attrGet("class") ?? "").includes("contains-task-list")) {
            list.attrJoin("class", "contains-task-list");
          }
        }
        break;
      }
    }
  }
}

/** heading anchors: a GitHub-style slug as the id, numbered when repeated */
function headingAnchors(state: StateCore): void {
  const seen = new Map<string, number>();
  const used = new Set<string>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i]!.type !== "heading_open") continue;
    const text = (tokens[i + 1]!.children ?? [])
      .filter((t) => t.type === "text" || t.type === "code_inline")
      .map((t) => t.content)
      .join("");
    const base = slugify(text);
    let slug = base;
    let n = seen.get(base) ?? 0;
    while (used.has(slug)) slug = `${base}-${++n}`;
    seen.set(base, n);
    used.add(slug);
    tokens[i]!.attrSet("id", anchorId(slug));
  }
}

/** table cell alignment as a class: markdown-it writes an inline style, and
 *  the sanitizer admits no style attribute at all */
function tableAlignment(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== "th_open" && token.type !== "td_open") continue;
    const align = /^text-align:(left|center|right)$/.exec(String(token.attrGet("style") ?? ""))?.[1];
    if (token.attrs) token.attrs = token.attrs.filter(([name]) => name !== "style");
    if (align) token.attrJoin("class", `align-${align}`);
  }
}

/** every link of the document, rewritten by what it points at */
function links(state: StateCore): void {
  const env = state.env as RenderEnv;
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const open: Token[] = [];
    for (const token of block.children) {
      if (token.type === "link_open") {
        open.push(token);
        rewriteLink(token, env);
      } else if (token.type === "link_close") {
        // an unavailable link renders as a span: close it as one
        token.tag = open.pop()?.tag ?? token.tag;
      }
    }
  }
}

function rewriteLink(token: Token, env: RenderEnv): void {
  const href = String(token.attrGet("href") ?? "");
  const target = classifyHref(href, env.docPath);
  switch (target.kind) {
    case "external":
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
      return;
    case "anchor":
      token.attrSet("href", `#${encodeURIComponent(target.fragment)}`);
      return;
    case "model":
      token.attrSet("href", modelRoute(env.repo, target.path, target.fragment));
      token.attrSet("data-model-path", target.path);
      return;
    case "file":
      token.tag = "span";
      token.attrs = [
        ["class", "md-link-unavailable"],
        [
          "title",
          target.path === undefined
            ? "This link points outside the repository"
            : `${target.path} is not a model, so it does not open in designIQ`,
        ],
      ];
      return;
    case "other":
      return;
  }
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

// GFM autolinks: URLs with a scheme, e-mail addresses and www. hosts. linkify-it
// finds bare domains only as "fuzzy" links, which would also turn every file
// name with a TLD-like extension (README.md, notes.sh) into a link: keep the
// fuzzy matches that start with www. and nothing else.
md.linkify.set({ fuzzyLink: true, fuzzyEmail: true });
md.linkify.add("//", null);
const linkifyMatch = md.linkify.match.bind(md.linkify);
md.linkify.match = (text) => linkifyMatch(text)?.filter((m) => m.schema !== "" || /^www\./i.test(m.raw)) ?? null;

md.core.ruler.push("designiq_task_lists", taskLists);
md.core.ruler.push("designiq_heading_anchors", headingAnchors);
md.core.ruler.push("designiq_table_alignment", tableAlignment);
md.core.ruler.push("designiq_links", links);

const { escapeHtml, unescapeAll } = md.utils;

// raw HTML never reaches the page, even if a future option let the parser emit it
md.renderer.rules.html_block = (tokens, idx) => `<p>${escapeHtml(tokens[idx]!.content)}</p>\n`;
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx]!.content);

md.renderer.rules.task_checkbox = (tokens, idx) =>
  `<input type="checkbox" class="task-list-item-checkbox" disabled${tokens[idx]!.meta?.checked ? " checked" : ""}> `;

// fenced code: the hook first, the plain code block (Geist Mono) otherwise
md.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx]!;
  const info = unescapeAll(token.info).trim();
  const lang = (info.split(/\s+/)[0] ?? "").toLowerCase();
  // own keys only: a ```constructor fence must not call Object's prototype
  const { fences } = env as RenderEnv;
  const custom = Object.hasOwn(fences, lang) ? fences[lang]?.(token.content, { lang, info }) : undefined;
  if (custom !== undefined) return custom;
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre class="md-code"><code${cls}>${escapeHtml(token.content)}</code></pre>\n`;
};
md.renderer.rules.code_block = (tokens, idx) =>
  `<pre class="md-code"><code>${escapeHtml(tokens[idx]!.content)}</code></pre>\n`;

// images: https and inline data images load (lazily, without a referrer);
// anything else, the repository's own relative images included, has no
// route to load from yet and shows as a placeholder naming the image
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const src = String(token.attrGet("src") ?? "");
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  if (/^https:\/\//i.test(src) || /^data:image\//i.test(src)) {
    token.attrSet("alt", alt);
    token.attrSet("loading", "lazy");
    token.attrSet("referrerpolicy", "no-referrer");
    return self.renderToken(tokens, idx, options);
  }
  // name a repository image by its repo-relative path, anything else by its URL
  const docPath = (env as RenderEnv).docPath;
  const where =
    (SCHEME.test(src) || src.startsWith("//") ? undefined : resolveRepoPath(src, docPath)) ?? safeDecode(src);
  const label = alt || where.split("/").pop() || "image";
  return `<span class="md-image-placeholder" title="${escapeHtml(where)}">Image not shown: ${escapeHtml(label)}</span>`;
};

/** render a Markdown document to (unsanitized, but escaped) HTML */
export function renderMarkdown(source: string, options: RenderOptions): string {
  const env: RenderEnv = { repo: options.repo, docPath: options.docPath, fences: options.fences ?? {} };
  return md.render(source, env);
}
