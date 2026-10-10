/**
 * The Miragon CI tokens as TS, for code that cannot read a CSS custom property:
 * Monaco themes (hex only), data-URL icons, SVG presentation colours. Pure data
 * plus a colour mixer — no DOM, so Node tests, the SPA and the vanilla widgets
 * all import it.
 *
 * Two mirrors, both drift-tested (test/tokens.test.ts):
 * - `CD` mirrors the vendored `cd-tokens.generated.css` (Miragon/corporate-
 *   identity, never edited here).
 * - `ALIASES` mirrors the semantic layer in `tokens.css` — one light mode, as
 *   the CI prescribes. The test evaluates the CSS, compares it with these
 *   values and checks WCAG contrast for every text/surface pair.
 */

/** the CI palette, UI layer and status colours — exact `--cd-*` values */
export const CD = {
  /** primary: buttons, surfaces, selection */
  blau: "#335DE5",
  /** interactive text on white (AA) */
  blauLink: "#2B50D4",
  /** blue on dark surfaces where it must be blue (a focus ring) */
  blauHell: "#6B8AFF",
  /** accent: key visual, highlights — a fill, never text on white */
  gruen: "#00E676",
  /** calm neutral surface (warm off-white) */
  grau: "#F9F7F7",
  /** text on light — and the CI's only dark ground (overlays, backdrops) */
  schwarz: "#1D1D1D",
  weiss: "#FFFFFF",
  success: "#0B7A55",
  warning: "#92610A",
  danger: "#C92A2A",
  info: "#2B50D4",
  /** decorative lines (no contrast claim) */
  linie: "#E6E2E2",
  /** non-text that needs ≥ 3:1 (input borders, edges) */
  kontur: "#8F8A8A",
  /** secondary text, ≥ 4.5:1 on weiss and grau */
  textLeise: "#6B6666",
} as const;

/** every `--cd-*` colour this repo relies on → the value the vendored CSS MUST hold */
export const CD_TOKENS: Record<string, string> = {
  "--cd-blau": CD.blau,
  "--cd-gruen": CD.gruen,
  "--cd-grau": CD.grau,
  "--cd-schwarz": CD.schwarz,
  "--cd-weiss": CD.weiss,
  "--cd-blau-link": CD.blauLink,
  "--cd-blau-hell": CD.blauHell,
  "--cd-success": CD.success,
  "--cd-warning": CD.warning,
  "--cd-danger": CD.danger,
  "--cd-info": CD.info,
  "--cd-linie": CD.linie,
  "--cd-kontur": CD.kontur,
  "--cd-text-leise": CD.textLeise,
};

/** the font stacks of `--designiq-font-sans` / `--designiq-font-mono` (fonts.css loads Geist) */
export const FONT_SANS = '"Geist Variable", Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** an sRGB colour: channels 0–255, alpha 0–1 */
export type Rgba = [number, number, number, number];

/** parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` or `transparent` */
export function parseColor(input: string): Rgba {
  const c = input.trim().toLowerCase();
  if (c === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(c)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((h) => h + h).join("") : hex;
    const byte = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [byte(0), byte(2), byte(4), full.length === 8 ? byte(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(c)?.[1];
  if (fn) {
    const [r = 0, g = 0, b = 0, a = 1] = fn
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return [r, g, b, a];
  }
  throw new Error(`unsupported colour: ${input}`);
}

/** `#rrggbb`, or `#rrggbbaa` when translucent — the form Monaco and SVG accept */
export function formatColor([r, g, b, a]: Rgba): string {
  const byte = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ""}`;
}

/**
 * CSS `color-mix(in srgb, a pct%, b)`: `pct` of `a`, the rest of `b`,
 * interpolated with premultiplied alpha exactly as the browser does — so
 * `mix(x, 12, "transparent")` is `x` at 12 % opacity.
 */
export function mix(a: string, pct: number, b: string): string {
  return formatColor(mixRgba(parseColor(a), pct, parseColor(b)));
}

export function mixRgba(a: Rgba, pct: number, b: Rgba): Rgba {
  const wa = pct / 100;
  const wb = 1 - wa;
  const alpha = a[3] * wa + b[3] * wb;
  const channel = (i: 0 | 1 | 2) => (alpha === 0 ? 0 : (a[i] * a[3] * wa + b[i] * b[3] * wb) / alpha);
  return [channel(0), channel(1), channel(2), alpha];
}

/**
 * The semantic layer of tokens.css — keys are the custom property names
 * without `--`. Read by code that needs real colour values (Monaco, renderer
 * defaults, data-URL icons); everything that can, uses `var(--…)` instead.
 */
export const ALIASES = {
  background: CD.weiss,
  foreground: CD.schwarz,
  card: CD.weiss,
  "card-foreground": CD.schwarz,
  popover: CD.weiss,
  "popover-foreground": CD.schwarz,
  primary: CD.blau,
  "primary-foreground": CD.weiss,
  "primary-hover": CD.blauLink,
  secondary: CD.grau,
  "secondary-foreground": CD.schwarz,
  muted: mix(CD.linie, 50, CD.grau),
  "muted-foreground": CD.textLeise,
  accent: mix(CD.blau, 10, "transparent"),
  "accent-foreground": CD.blauLink,
  destructive: CD.danger,
  "destructive-foreground": CD.weiss,
  success: CD.success,
  warning: CD.warning,
  info: CD.info,
  /** opaque: the CI -soft 12 % over the ground, so no row tint shows through */
  "success-soft": mix(CD.success, 12, CD.weiss),
  "warning-soft": mix(CD.warning, 12, CD.weiss),
  "destructive-soft": mix(CD.danger, 12, CD.weiss),
  link: CD.blauLink,
  brand: CD.gruen,
  border: CD.linie,
  input: CD.kontur,
  ring: CD.blauLink,
  overlay: mix(CD.schwarz, 42, "transparent"),
  "canvas-background": CD.weiss,
  "canvas-shape": CD.weiss,
  "canvas-stroke": CD.schwarz,
  "canvas-label": CD.schwarz,
  "canvas-accent": CD.blau,
} as const satisfies Record<string, string>;

export type AliasToken = keyof typeof ALIASES;
