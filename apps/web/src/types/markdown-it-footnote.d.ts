/** markdown-it-footnote ships no types: the plugin as markdown-it's use() takes it
 *  (@types/markdown-it-footnote would bring a second set of markdown-it types) */
declare module "markdown-it-footnote" {
  import type { MarkdownIt } from "markdown-it";

  export default function footnote(md: MarkdownIt): void;
}
