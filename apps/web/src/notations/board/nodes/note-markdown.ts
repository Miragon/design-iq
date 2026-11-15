/**
 * A text note's Markdown as a sanitized DOM fragment.
 *
 * markdown-it and DOMPurify load with the first note, through import(): the arch rule
 * web-markdown-engine-loads-lazily keeps both out of every eagerly loaded module of the web app.
 * The note has a small Markdown of its own and not the Markdown view's (notations/markdown): no
 * raw HTML, no images (an image is a node of the board), no anchors, no links between models.
 * A line break in the text is a line break in the note, as a person writing a note expects.
 *
 * A board file is untrusted like any repository content. markdown-it escapes raw HTML and refuses
 * javascript:, vbscript:, file: and data: links; DOMPurify then holds the result to the tags a
 * note can produce, so a slip of the renderer never reaches the page as a script or a handler.
 */
export type RenderNote = (markdown: string) => DocumentFragment;

const TAGS = [
  ...["p", "br", "strong", "em", "s", "code", "pre", "blockquote", "hr", "a"],
  ...["ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6"],
  ...["table", "thead", "tbody", "tr", "th", "td"],
];

let loaded: RenderNote | undefined;
let loading: Promise<RenderNote> | undefined;

/** the renderer once it is there: a note that mounts later renders at once */
export const noteRenderer = (): RenderNote | undefined => loaded;

export function loadNoteRenderer(): Promise<RenderNote> {
  loading ??= Promise.all([import("markdown-it"), import("dompurify")]).then(
    ([{ default: MarkdownIt }, { default: DOMPurify }]) => {
      const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable("image");
      // an instance of its own: the hook below must not reach any other user of DOMPurify
      const purify = DOMPurify(window);
      purify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName !== "A") return;
        // a link leaves the board in a new tab, without an opener; anything but a web or mail
        // address would lead nowhere from here and stays text
        if (/^(https?:|mailto:)/i.test(node.getAttribute("href") ?? "")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        } else node.removeAttribute("href");
      });
      loaded = (text) =>
        purify.sanitize(markdown.render(text), {
          ALLOWED_TAGS: TAGS,
          ALLOWED_ATTR: ["href", "start"],
          ALLOW_DATA_ATTR: false,
          RETURN_DOM_FRAGMENT: true,
        });
      return loaded;
    },
  );
  return loading;
}
