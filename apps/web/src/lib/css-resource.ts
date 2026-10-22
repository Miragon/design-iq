/**
 * CSS that could fetch from another site: a url() or src() not to the
 * document itself (#…), an image-set(), an @import, or a backslash, because
 * a CSS escape can spell any of them. Shared by the Mermaid renderer (a
 * diagram's configuration, lib/mermaid-render.ts) and the diagram sanitizer
 * (an attribute or a style sheet, notations/markdown/sanitize.ts), so both
 * refuse the same thing (#290). Dependency-free: the sanitizer runs under
 * node --test.
 */
export const CSS_RESOURCE = /(?:url|src)\(\s*(?!["']?\s*#)|image-set|@import|\\/i;
