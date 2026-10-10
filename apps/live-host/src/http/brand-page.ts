/**
 * The shell of the few pages the Live Host and its tools render themselves —
 * the editor sign-in landing (editor-login.ts) and the one-time GitHub App
 * creation page (tools/create-app.ts) — in the Miragon CI: grau page ground,
 * one white card, the blue primary button, Geist.
 *
 * These pages cannot load the SPA's sheet (the create-app tool runs before any
 * web build exists, the sign-in landing is one response), so the style is
 * inline. The values are the CI tokens, declared ONCE below under their --cd-*
 * names and drift-tested against the vendored
 * packages/ui-kit/src/cd-tokens.generated.css (test/brand-page.test.ts). One
 * light mode, as the CI prescribes.
 *
 * The fonts ride inline too, as data: URIs read once at module load from
 * fontsource (the SPA's source): Geist's latin subset only (~29 KB woff2) —
 * these pages are English UI copy plus a GitHub login, anything beyond latin
 * falls back to the system sans. Geist Mono's latin subset (~23 KB) only goes
 * into a page whose body has a <code> (the create-app pages: a path, a command,
 * an env name — set apart in the CI's mono, not the system's), so the editor
 * sign-in landing stays at the one face.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** an @font-face carrying a fontsource variable woff2 inline (every weight) */
const inlineFace = (family: string, file: string): string =>
  `@font-face{font-family:"${family}";font-style:normal;font-weight:100 900;font-display:swap;` +
  `src:url(data:font/woff2;base64,${readFileSync(require.resolve(file)).toString("base64")}) format("woff2")}`;

const GEIST = inlineFace("Geist", "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2");
const GEIST_MONO = inlineFace("Geist Mono", "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2");

const STYLE = `:root{color-scheme:light;
--cd-blau:#335DE5;--cd-blau-link:#2B50D4;--cd-grau:#F9F7F7;--cd-schwarz:#1D1D1D;--cd-weiss:#FFFFFF;
--cd-linie:#E6E2E2;--cd-text-leise:#6B6666;--cd-success:#0B7A55;
--cd-shadow-1:0 1px 2px rgba(29, 29, 29, 0.06), 0 1px 3px rgba(29, 29, 29, 0.10);
--cd-shadow-2:0 4px 12px rgba(29, 29, 29, 0.10);--cd-ease:cubic-bezier(0.4, 0, 0.2, 1)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
background:var(--cd-grau);color:var(--cd-schwarz);
font:16px/1.6 Geist,"Geist Variable",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:100%;max-width:560px;overflow-wrap:break-word;padding:40px 48px;background:var(--cd-weiss);
border:1px solid var(--cd-linie);border-radius:12px;box-shadow:var(--cd-shadow-2)}
h1{margin:0 0 16px;font-size:28px;line-height:1.2;font-weight:700}
h1 em{font-style:normal;color:var(--cd-blau-link)}
p{margin:0 0 16px}
.note{margin:16px 0 0;font-size:13px;line-height:1.5;color:var(--cd-text-leise)}
.status{display:block;margin-bottom:16px;color:var(--cd-success)}
a{color:var(--cd-blau-link);text-underline-offset:2px}
code{padding:1px 5px;white-space:nowrap;font:.875em "Geist Mono","Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace;
background:var(--cd-grau);border:1px solid var(--cd-linie);border-radius:6px}
button{padding:12px 22px;font:inherit;font-weight:600;color:var(--cd-weiss);background:var(--cd-blau);
border:0;border-radius:12px;box-shadow:var(--cd-shadow-1);cursor:pointer;
transition:background-color 150ms var(--cd-ease),box-shadow 150ms var(--cd-ease),transform 150ms var(--cd-ease)}
button:hover{background:var(--cd-blau-link);box-shadow:var(--cd-shadow-2);transform:translateY(-1px)}
button:active{transform:none;box-shadow:var(--cd-shadow-1)}
a:focus-visible,button:focus-visible{outline:2px solid var(--cd-blau-link);outline-offset:2px}
@media (max-width:480px){.card{padding:32px 24px}}
@media (prefers-reduced-motion:reduce){button{transition:none}button:hover{transform:none}}`;

/** Lucide "circle-check" (lucide-react 1.51.0, the SPA's set; outline, currentColor)
 *  — the success mark; decorative, the heading says it */
export const SUCCESS_ICON =
  '<svg class="status" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/></svg>';

/** a complete page: `title` and `body` are trusted HTML — callers escape what
 *  they interpolate; `head` takes extra head elements (a meta refresh) */
export function brandPage({ title, body, head = "" }: { title: string; body: string; head?: string }): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...(head ? [head] : []),
    `<title>${title}</title>`,
    `<style>${GEIST}${body.includes("<code") ? GEIST_MONO : ""}${STYLE}</style>`,
    "</head><body>",
    `<main class="card">${body}</main>`,
    "</body></html>",
  ].join("\n");
}
