/**
 * The inline CI shell of the Live Host's own pages (src/http/brand-page.ts):
 * it cannot import the vendored token sheet, so it repeats the --cd-* values it
 * uses — this pins them to packages/ui-kit/src/cd-tokens.generated.css, the
 * same way ui-kit's own drift test pins lib/tokens.ts. Re-copying the sheet
 * from the CI skill with a changed value fails here until the shell follows.
 * Geist rides inline the same way — no font file to serve, none to install.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { brandPage } from "../src/http/brand-page.ts";

const vendored = readFileSync(new URL("../../../packages/ui-kit/src/cd-tokens.generated.css", import.meta.url), "utf8");
const page = brandPage({ title: "t", body: "<p>b</p>" });

/** `--cd-name: value` declarations, whitespace-free and lowercased for comparison */
const cdDeclarations = (css: string): Map<string, string> =>
  new Map(
    [...css.matchAll(/(--cd-[\w-]+)\s*:\s*([^;}]+)[;}]/g)].map((m) => [m[1]!, m[2]!.replace(/\s+/g, "").toLowerCase()]),
  );

test("every --cd-* value of the shell is the vendored CI token", () => {
  const ci = cdDeclarations(vendored);
  const shell = cdDeclarations(page);
  assert.ok(shell.size >= 8, "the shell declares its tokens");
  for (const [name, value] of shell) assert.equal(value, ci.get(name), `${name} drifted from the CI`);
});

test("the shell is light only and uses no colour outside its tokens", () => {
  assert.ok(page.includes("color-scheme:light"));
  assert.ok(!/prefers-color-scheme|\.dark\b/.test(page), "no dark mode");
  const outsideRoot = page.slice(page.indexOf("}", page.indexOf(":root{")) + 1);
  assert.deepEqual(outsideRoot.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi), null, "colours come from var(--cd-*)");
});

/** the inline @font-face of `family`: its src decoded back to the font bytes */
const inlineFont = (html: string, family: string): Buffer | undefined => {
  const face = new RegExp(
    `@font-face\\{font-family:"${family}";[^}]*src:url\\(data:font/woff2;base64,([A-Za-z0-9+/=]+)\\)`,
  );
  const base64 = face.exec(html)?.[1];
  return base64 === undefined ? undefined : Buffer.from(base64, "base64");
};

test("Geist ships inline — the page needs no font file and no installed font", () => {
  const geist = inlineFont(page, "Geist");
  assert.ok(geist, "an @font-face for Geist with a woff2 data: src");
  assert.equal(geist.subarray(0, 4).toString("latin1"), "wOF2", "a real woff2");
  assert.ok(/body\{[^}]*font:[^;}]*\bGeist,/.test(page), "the body text asks for that family");
  // the mono face only rides along where a <code> needs it (the create-app pages)
  assert.equal(inlineFont(page, "Geist Mono"), undefined, "no Geist Mono without a <code>");
  const withCode = brandPage({ title: "t", body: "<p>run <code>pnpm start</code></p>" });
  assert.equal(inlineFont(withCode, "Geist Mono")?.subarray(0, 4).toString("latin1"), "wOF2");
});
