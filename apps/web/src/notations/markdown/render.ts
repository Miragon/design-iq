/**
 * The Markdown view's renderer, PURE: Markdown source in, an HTML string out.
 * markdown-it renders CommonMark plus the GFM extensions the content repos
 * use (tables, strikethrough, task lists, autolinks, footnotes) and gives
 * every heading an anchor. The DOM side is ./sanitize.ts (DOMPurify) and
 * ./view.ts (mounting, clicks, scrolling).
 *
 * Node-loadable on purpose (test/markdown-render.test.ts): relative `.ts`
 * imports, no "@/" alias, nothing DOM-bound.
 *
 * Content-repo Markdown is untrusted. Raw HTML passes only as the small
 * subset GitHub authors use for layout (PASSED_TAGS: a line break, a
 * collapsible section, sub- and superscript, a key), and only as bare tags
 * the renderer writes itself: every attribute is dropped but a <details>'
 * `open`. The parser recognises raw HTML (so an HTML comment stays hidden, as
 * on GitHub), and the two html render rules drop comments, pass that subset
 * and escape everything else. markdown-it's validateLink keeps javascript:,
 * vbscript:, file: and non-image data: URLs from becoming a link or an image;
 * a link with any scheme but http(s), mailto: and tel: renders as text; the
 * view sanitizes the result once more (DOMPurify) before it reaches the page.
 *
 * Links between models: a relative link resolves against the document's
 * folder (a leading "/" against the repository root, as on GitHub). A target
 * the repository has a model at becomes its in-app route; any other
 * repository file (a folder, an image, source code, a document outside the
 * models folder) is not something designIQ opens, so it renders as plain,
 * marked text instead of a link that would lead nowhere. A link to a file of
 * the repository on GitHub (RenderOptions.repoWeb) opens in designIQ when it
 * names the default branch, the one designIQ shows, and a model or this
 * document; any other GitHub address stays a web link.
 *
 * Images: an image of the repository (a relative path) loads from the Live
 * Host, like the document itself. An image from another site loads only once
 * the reader asks for it (RenderOptions.externalImages): its host would see
 * every reader's address, time and browser, so until then a placeholder names
 * the host. Inline data images need no request and show at once.
 */
import { repoImageRoute, repoImageType } from "@designiq/contracts/live";
import { byExtension } from "@designiq/notations";
import MarkdownIt, { type Env, type StateCore, type Token } from "markdown-it";
import footnote from "markdown-it-footnote";

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
  /** the repository on GitHub: a link to a model of it there opens in
   *  designIQ. Absent (still unknown) = every GitHub address is a web link */
  repoWeb?: RepoWeb;
  /** fence renderers by language (lower-case); a language without one renders as code */
  fences?: Readonly<Record<string, FenceRenderer>>;
  /** the repo-relative paths of the repository's models; absent (the list
   *  is still loading) = every path with a notation extension counts as one */
  models?: ReadonlySet<string>;
  /** the addresses of the images from other sites the reader chose to load;
   *  every other one renders as a placeholder that offers to load it */
  externalImages?: ReadonlySet<string>;
  /** the routes of the repository images that did not load: placeholders */
  brokenImages?: ReadonlySet<string>;
}

/** where the repository lives on GitHub (RenderOptions.repoWeb) */
export interface RepoWeb {
  /** GitHub's web address: https://github.com, or a GitHub Enterprise server's */
  base: string;
  /** the branch designIQ shows the repository at */
  defaultBranch: string;
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
  /** a mailto: or tel: address: left to the browser */
  | { kind: "contact" }
  /** any other scheme markdown-it lets through (vscode:, ms-word:, data:image/): not followed */
  | { kind: "scheme"; scheme: string };

/** where an image of the document comes from */
export type ImageSource =
  /** a data:image/ URL: nothing to fetch */
  | { kind: "inline" }
  /** a file of the repository, served by the Live Host */
  | { kind: "repository"; path: string }
  /** another site: loads only once the reader asks for it */
  | { kind: "external"; url: string; host: string }
  /** nothing designIQ loads (an http: address, another scheme, a path
   *  outside the repository, a file that is no image), named by `where` */
  | { kind: "unavailable"; where: string };

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

/** whether the repository has a model at `path`; without the model list,
 *  whether the path has a notation extension */
const isModelPath = (path: string, models: ReadonlySet<string> | undefined): boolean =>
  models ? models.has(path) : !path.endsWith("/") && byExtension(path) !== undefined;

/**
 * The repository path and section a GitHub address names when it is a file
 * of `web.repo` on its default branch, owner and name in any case:
 * `<base>/<owner>/<name>/blob/<branch>/<path>#<section>`. Undefined for any
 * other address: another repository, branch or commit, a folder (`/tree/`).
 */
export function repoFileOnWeb(
  href: string,
  web: RepoWeb & { repo: string },
): { path: string; fragment: string } | undefined {
  let url: URL;
  let base: URL;
  try {
    url = new URL(href.startsWith("//") ? `https:${href}` : href);
    base = new URL(web.base);
  } catch {
    return undefined;
  }
  const root = base.pathname.replace(/\/+$/, "");
  if (url.origin !== base.origin || !url.pathname.startsWith(`${root}/`)) return undefined;
  const [owner = "", name = "", kind, ...rest] = url.pathname.slice(root.length + 1).split("/");
  if (kind !== "blob" || `${safeDecode(owner)}/${safeDecode(name)}`.toLowerCase() !== web.repo.toLowerCase()) {
    return undefined;
  }
  // a branch name may hold a "/": it takes as many segments
  const branch = web.defaultBranch.split("/");
  if (rest.length <= branch.length || branch.some((segment, i) => safeDecode(rest[i]!) !== segment)) return undefined;
  const path = resolveRepoPath(`/${rest.slice(branch.length).join("/")}`, "");
  return path ? { path, fragment: safeDecode(url.hash.slice(1)) } : undefined;
}

/**
 * Where a link of the document at `docPath` points. `models` are the
 * repository's model paths; without them a target with a notation extension
 * counts as a model (the shell checks again when the link is clicked). With
 * `web`, a GitHub address of a model of the repository, or of this document,
 * at its default branch counts as a relative link to it would.
 */
export function classifyHref(
  href: string,
  docPath: string,
  models?: ReadonlySet<string>,
  web?: RepoWeb & { repo: string },
): LinkTarget {
  if (href.startsWith("//") || /^https?:/i.test(href)) {
    const file = web && repoFileOnWeb(href, web);
    if (file?.path === docPath) return { kind: "anchor", fragment: file.fragment };
    return file && isModelPath(file.path, models) ? { kind: "model", ...file } : { kind: "external" };
  }
  if (/^(mailto|tel):/i.test(href)) return { kind: "contact" };
  const scheme = SCHEME.exec(href)?.[0];
  if (scheme) return { kind: "scheme", scheme: scheme.toLowerCase() };
  const hashAt = href.indexOf("#");
  const fragment = hashAt < 0 ? "" : safeDecode(href.slice(hashAt + 1));
  const pathPart = (hashAt < 0 ? href : href.slice(0, hashAt)).replace(/\?.*$/, "");
  if (pathPart === "") return { kind: "anchor", fragment };
  const path = resolveRepoPath(pathPart, docPath);
  if (path === undefined) return { kind: "file", path: undefined };
  if (path === docPath) return { kind: "anchor", fragment };
  return isModelPath(path, models) ? { kind: "model", path, fragment } : { kind: "file", path };
}

/**
 * Where an image `src` of the document at `docPath` comes from (`src` as
 * markdown-it normalized it, so percent-encoded). A protocol-relative address
 * is an https one, as on the https page designIQ serves.
 */
export function classifyImage(src: string, docPath: string): ImageSource {
  if (/^data:image\//i.test(src)) return { kind: "inline" };
  const url = src.startsWith("//") ? `https:${src}` : src;
  if (/^https:\/\//i.test(url)) {
    try {
      return { kind: "external", url, host: new URL(url).host };
    } catch {
      return { kind: "unavailable", where: safeDecode(src) };
    }
  }
  if (SCHEME.test(src)) return { kind: "unavailable", where: safeDecode(src) };
  const pathPart = src.replace(/[?#].*$/, "");
  const path = pathPart === "" ? undefined : resolveRepoPath(pathPart, docPath);
  if (path === undefined || repoImageType(path) === undefined)
    return { kind: "unavailable", where: path ?? safeDecode(src) };
  return { kind: "repository", path };
}

/** what the core rules read from markdown-it's env */
interface RenderEnv extends Env {
  repo: string;
  docPath: string;
  repoWeb?: RepoWeb;
  fences: Readonly<Record<string, FenceRenderer>>;
  models: ReadonlySet<string> | undefined;
  externalImages: ReadonlySet<string> | undefined;
  brokenImages: ReadonlySet<string> | undefined;
  /** parseMarkdown: footnote definitions stay where they are in the source */
  footnotesInPlace?: boolean;
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
    // the SOURCE decides: an escaped marker ("\[ ]") is text, although by
    // now its backslash is gone from the merged text token
    if (!TASK_MARKER.test(inline.content)) continue;
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

/** a link rendered as marked, inert text: its title says why it does not open */
function unavailable(token: Token, title: string): void {
  token.tag = "span";
  token.attrs = [
    ["class", "md-link-unavailable"],
    ["title", title],
  ];
}

function rewriteLink(token: Token, env: RenderEnv): void {
  const href = String(token.attrGet("href") ?? "");
  const web = env.repoWeb && { repo: env.repo, ...env.repoWeb };
  const target = classifyHref(href, env.docPath, env.models, web);
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
      unavailable(
        token,
        target.path === undefined
          ? "This link points outside the repository"
          : `${target.path} is not a model of this repository, so it does not open in designIQ`,
      );
      return;
    case "scheme":
      unavailable(token, `A ${target.scheme} link does not open from designIQ`);
      return;
    case "contact":
      return;
  }
}

// `html: true` only lets the parser RECOGNISE raw HTML: the html render rules
// below drop comments, write the passed tags anew and escape the rest, so no
// markup of the document's own reaches the page. (With `html: false` a
// comment would show as text, and its lines would render as Markdown.)
const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

// GFM autolinks: URLs with a scheme, e-mail addresses and www. hosts. linkify-it
// finds bare domains only as "fuzzy" links, which would also turn every file
// name with a TLD-like extension (README.md, notes.sh) into a link: keep the
// fuzzy matches that start with www. and nothing else.
md.linkify.set({ fuzzyLink: true, fuzzyEmail: true });
md.linkify.add("//", null);
const linkifyMatch = md.linkify.match.bind(md.linkify);
md.linkify.match = (text) => linkifyMatch(text)?.filter((m) => m.schema !== "" || /^www\./i.test(m.raw)) ?? null;

// GFM footnotes, as on GitHub: a reference is a superscript number, the
// notes a numbered list at the end of the document, each with a link back to
// its references; a definition nothing refers to is not shown. GitHub has no
// inline footnotes: "^[note]" stays text.
md.use(footnote);
md.inline.ruler.disable("footnote_inline");

// a "[^label]:" line that is no footnote definition (a blank in the label)
// stays text: as a link reference definition its text would vanish
const referenceRule = md.block.ruler.__rules__.find((rule) => rule.name === "reference")!.fn;
md.block.ruler.at("reference", (state, startLine, endLine, silent) =>
  state.src.startsWith("[^", state.bMarks[startLine]! + state.tShift[startLine]!)
    ? false
    : referenceRule(state, startLine, endLine, silent),
);

/** markdown-it-footnote's part of the env: the defined labels (":" + label,
 *  -1 until the first reference, then the note's index) and the notes */
interface FootnoteEnv extends Env {
  footnotes?: { refs?: Record<string, number>; list?: { label: string; count: number }[] };
}

// GitHub matches a footnote label as it matches a link label, case-folded and
// with its blanks collapsed: "[^Note]" refers to "[^note]: …". The plugin
// matches labels as written, so a definition is filed under its folded label
// below, and the reference rule, the plugin's own but for the folding, looks
// a label up folded
const footnoteLabel = (label: string): string => md.utils.normalizeReference(label);

// a definition's opening token gets the lines of its content, as every other
// block's has: ./insert-diagram.ts reads a definition as one block
const footnoteDefinition = md.block.ruler.__rules__.find((rule) => rule.name === "footnote_def")!.fn;
md.block.ruler.at(
  "footnote_def",
  (state, startLine, endLine, silent) => {
    const at = state.tokens.length;
    if (!footnoteDefinition(state, startLine, endLine, silent)) return false;
    if (!silent) {
      const definition = state.tokens[at]!;
      let end = startLine + 1;
      for (let i = at; i < state.tokens.length; i++) end = Math.max(end, state.tokens[i]!.map?.[1] ?? 0);
      definition.map = [startLine, end];
      const written = definition.meta!.label as string;
      const label = footnoteLabel(written);
      const defined = (state.env as FootnoteEnv).footnotes!.refs!;
      delete defined[`:${written}`];
      defined[`:${label}`] = -1;
      definition.meta!.label = label;
    }
    return true;
  },
  { alt: ["paragraph", "reference"] },
);

const FOOTNOTE_REFERENCE = /\[\^([^\]\n ]+)\]/y;
md.inline.ruler.at("footnote_ref", (state, silent) => {
  const footnotes = (state.env as FootnoteEnv).footnotes;
  const defined = footnotes?.refs;
  if (!footnotes || !defined) return false;
  FOOTNOTE_REFERENCE.lastIndex = state.pos;
  const written = FOOTNOTE_REFERENCE.exec(state.src)?.[1];
  if (written === undefined || FOOTNOTE_REFERENCE.lastIndex > state.posMax) return false;
  const label = footnoteLabel(written);
  const known = defined[`:${label}`];
  if (known === undefined) return false;
  if (!silent) {
    const notes = (footnotes.list ??= []);
    const id = known < 0 ? notes.length : known;
    if (known < 0) {
      notes[id] = { label, count: 0 };
      defined[`:${label}`] = id;
    }
    state.push("footnote_ref", "", 0).meta = { id, subId: notes[id]!.count++, label };
  }
  state.pos = FOOTNOTE_REFERENCE.lastIndex;
  return true;
});

// parseMarkdown reads the blocks where the source has them: only the render
// moves the footnotes to the end of the document (and drops the ones nothing
// refers to)
const footnoteTail = md.core.ruler.__rules__.find((rule) => rule.name === "footnote_tail")!.fn;
md.core.ruler.at("footnote_tail", (state) => {
  if ((state.env as RenderEnv).footnotesInPlace) return;
  // a label defined twice keeps its first definition, as on GitHub, where the
  // plugin keeps its last: a later one gets the empty label no reference has
  const defined = new Set<string>();
  for (const token of state.tokens) {
    if (token.type !== "footnote_reference_open") continue;
    const label = token.meta!.label as string;
    if (defined.has(label)) token.meta!.label = "";
    defined.add(label);
  }
  footnoteTail(state);
});

md.core.ruler.push("designiq_task_lists", taskLists);
md.core.ruler.push("designiq_heading_anchors", headingAnchors);
md.core.ruler.push("designiq_table_alignment", tableAlignment);
md.core.ruler.push("designiq_links", links);

const { escapeHtml, unescapeAll } = md.utils;

/** text as HTML text: what a fence renderer wraps its source in */
export const escapeText = (text: string): string => escapeHtml(text);

// the document's own markup never reaches the page: comments are dropped
// (GitHub hides them too: authoring notes, lint and toc directives), the tags
// of PASSED_TAGS are written anew, bare, and everything else is escaped and
// shows as the text it is. An unclosed comment runs to the end, as in a
// browser.
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/** the raw HTML GitHub renders that the view renders too */
const PASSED_TAGS: ReadonlySet<string> = new Set(["br", "details", "summary", "sub", "sup", "kbd"]);

// a tag as CommonMark reads raw HTML (markdown-it's html_re)
const ATTRIBUTE_NAME = "[a-zA-Z_:][a-zA-Z0-9:._-]*";
const ATTRIBUTE_VALUE = `(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?`;
const TAG = `<([A-Za-z][A-Za-z0-9-]*)((?:\\s+${ATTRIBUTE_NAME}${ATTRIBUTE_VALUE})*)\\s*\\/?>|<\\/([A-Za-z][A-Za-z0-9-]*)\\s*>`;
const ONE_TAG = new RegExp(`^(?:${TAG})$`);
const TAGS = new RegExp(TAG, "g");
const ATTRIBUTE_NAMES = new RegExp(`\\s+(${ATTRIBUTE_NAME})${ATTRIBUTE_VALUE}`, "g");

/** a raw tag as the view writes it: a tag of PASSED_TAGS bare, undefined for any other */
function passedTag(raw: string): string | undefined {
  const match = ONE_TAG.exec(raw);
  if (!match) return undefined;
  const [, openName, attributes = "", closeName] = match;
  const name = (openName ?? closeName ?? "").toLowerCase();
  if (!PASSED_TAGS.has(name)) return undefined;
  // a br closes nothing: a browser reads </br> as a line break as well
  if (closeName !== undefined) return name === "br" ? "<br>" : `</${name}>`;
  const open =
    name === "details" && [...attributes.matchAll(ATTRIBUTE_NAMES)].some(([, attr]) => attr!.toLowerCase() === "open");
  return open ? "<details open>" : `<${name}>`;
}

/** text of the document's raw HTML: a character reference stays one, as on
 *  GitHub, anything else that is markup is escaped */
const htmlText = (text: string): string =>
  text
    .replace(/&(?!(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** the passed tags that open or close a collapsible section, a block of its own */
const SECTION_TAG = /^<\/?(?:details|summary)\b/;

// an HTML block with a <details> or <summary> is that markup, without a
// paragraph around it: the section holds the Markdown after it. Any other
// block shows as the text it is, in a paragraph of its own, with its line
// breaks, sub- and superscripts and keys passed
md.renderer.rules.html_block = (tokens, idx) => {
  const text = tokens[idx]!.content.replace(HTML_COMMENT, "").trim();
  if (text === "") return "";
  let html = "";
  let passed = false;
  let section = false;
  let at = 0;
  for (const match of text.matchAll(TAGS)) {
    const tag = passedTag(match[0]);
    passed ||= tag !== undefined;
    section ||= tag !== undefined && SECTION_TAG.test(tag);
    html += htmlText(text.slice(at, match.index)) + (tag ?? escapeHtml(match[0]));
    at = match.index + match[0].length;
  }
  html += htmlText(text.slice(at));
  return section ? `${html}\n` : `<p>${passed ? html : escapeHtml(text)}</p>\n`;
};
md.renderer.rules.html_inline = (tokens, idx) => {
  const raw = tokens[idx]!.content.replace(HTML_COMMENT, "");
  return passedTag(raw) ?? escapeHtml(raw);
};

// footnote ids: md- like every id of the view, then a capital letter, which
// no heading slug has, so a note never takes a heading's anchor. A note is
// numbered in the order of its first reference; a reference's id is its
// note's number, the n-th reference to a note numbered once more, as on GitHub
const FOOTNOTE = "Footnote-";
const FOOTNOTE_REF = "Footnote-ref-";

/** a footnote token's note (1-based) and which reference to it (1-based),
 *  from markdown-it-footnote's meta: id and subId count from 0 */
function footnoteOf(token: Token): { note: number; reference: number; name: string } {
  const { id = 0, subId = 0 } = (token.meta ?? {}) as { id?: number; subId?: number };
  const note = id + 1;
  const reference = subId + 1;
  return { note, reference, name: reference > 1 ? `${note}-${reference}` : `${note}` };
}

md.renderer.rules.footnote_ref = (tokens, idx) => {
  const { note, name } = footnoteOf(tokens[idx]!);
  return (
    `<sup class="md-footnote-ref"><a href="#${FOOTNOTE}${note}" id="${anchorId(FOOTNOTE_REF + name)}"` +
    ` aria-label="Footnote ${note}">${note}</a></sup>`
  );
};
md.renderer.rules.footnote_block_open = () => '<section class="md-footnotes" aria-label="Footnotes">\n<ol>\n';
md.renderer.rules.footnote_block_close = () => "</ol>\n</section>\n";
md.renderer.rules.footnote_open = (tokens, idx) => `<li id="${anchorId(FOOTNOTE + footnoteOf(tokens[idx]!).note)}">`;
md.renderer.rules.footnote_close = () => "</li>\n";
// the link back to a reference; its icon comes from the view, which the
// sanitizer admits no SVG for
md.renderer.rules.footnote_anchor = (tokens, idx) => {
  const { reference, name } = footnoteOf(tokens[idx]!);
  const nth = reference > 1 ? `<sup>${reference}</sup>` : "";
  return ` <a href="#${FOOTNOTE_REF}${name}" class="md-footnote-backref" aria-label="Back to reference ${name}">${nth}</a>`;
};

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

/** the last segment of a path or address, "image" for none */
const fileName = (where: string): string => where.split("/").filter(Boolean).pop() ?? "image";

/** an image in place of the picture: its name, and the place it would come from */
const imagePlaceholder = (where: string, label: string): string =>
  `<span class="md-image-placeholder" title="${escapeHtml(where)}">Image not shown: ${escapeHtml(label)}</span>`;

// images: inline data images show, a repository image loads from the Live
// Host, an image from another site only once the reader asked for it (the
// reader's address is what that site would learn). Every other image, and a
// repository image that did not load, is a placeholder naming it
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const src = String(token.attrGet("src") ?? "");
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  const { repo, docPath, externalImages, brokenImages } = env as RenderEnv;
  const source = classifyImage(src, docPath);
  token.attrSet("alt", alt);
  token.attrSet("loading", "lazy");
  switch (source.kind) {
    case "inline":
      return self.renderToken(tokens, idx, options);
    case "repository": {
      const route = repoImageRoute(repo, source.path);
      if (brokenImages?.has(route)) return imagePlaceholder(source.path, alt || fileName(source.path));
      token.attrSet("src", route);
      token.attrSet("class", "md-repo-image");
      return self.renderToken(tokens, idx, options);
    }
    case "external": {
      if (externalImages?.has(source.url)) {
        token.attrSet("src", source.url);
        token.attrSet("referrerpolicy", "no-referrer");
        return self.renderToken(tokens, idx, options);
      }
      const label = alt || fileName(safeDecode(new URL(source.url).pathname));
      return (
        `<span class="md-image-external" title="${escapeHtml(source.url)}">` +
        `<span class="md-image-external-text">Image from <strong>${escapeHtml(source.host)}</strong>: ${escapeHtml(label)}</span>` +
        `<button type="button" class="md-image-load" data-image-src="${escapeHtml(source.url)}"` +
        ` aria-label="Load image ${escapeHtml(label)} from ${escapeHtml(source.host)}"` +
        ` title="Loading it sends your IP address to ${escapeHtml(source.host)}">Load image</button></span>`
      );
    }
    case "unavailable":
      return imagePlaceholder(source.where, alt || fileName(source.where));
  }
};

/** render a Markdown document to (unsanitized, but escaped) HTML */
export function renderMarkdown(source: string, options: RenderOptions): string {
  const env: RenderEnv = {
    repo: options.repo,
    docPath: options.docPath,
    repoWeb: options.repoWeb,
    fences: options.fences ?? {},
    models: options.models,
    externalImages: options.externalImages,
    brokenImages: options.brokenImages,
  };
  return md.render(source, env);
}

/** the tokens renderMarkdown renders a document from (its links resolved as
 *  in a document at the repository root, every footnote definition where the
 *  source has it): test/markdown-fences.test.ts holds the validator's fence
 *  scanner against their fences, and ./insert-diagram.ts reads from them the
 *  blocks a diagram must not be inserted into */
export function parseMarkdown(source: string): Token[] {
  const env: RenderEnv = {
    repo: "",
    docPath: "",
    fences: {},
    models: undefined,
    externalImages: undefined,
    brokenImages: undefined,
    footnotesInPlace: true,
  };
  return md.parse(source, env);
}
