// The docs site in the Miragon corporate design (see custom.css).
// theme-without-fonts drops VitePress' bundled Inter: the CI typeface is
// Geist / Geist Mono, self-hosted through @fontsource (italic included for
// emphasis and quotes), so the site loads no font from a CDN.
import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme-without-fonts"
import "@fontsource-variable/geist"
import "@fontsource-variable/geist/wght-italic.css"
import "@fontsource-variable/geist-mono"
// The CI tokens (--cd-*), vendored unchanged from miragon-brand. They load
// before custom.css, which maps the VitePress variables onto them.
import "./cd-tokens.generated.css"
import "./custom.css"

export default {
  extends: DefaultTheme,
} satisfies Theme
