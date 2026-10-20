/**
 * The SPA's scoping of the Miragon renderer stylesheets
 * (src/notations/miragon/vendor-css.ts), run over the sheets apps/web pins:
 * which selectors it leaves global. A global selector applies to the whole
 * app once a renderer's chunk has loaded, bpmn-js and dmn-js included, so
 * each one is listed here with the reason it may stay, and a renderer bump
 * that adds one fails until it is reviewed. The --cd-* tokens a sheet sets on
 * :root outside a cascade layer override the app's own, so they must be
 * ui-kit's, value for value: a bump that changes one fails as well.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

import postcss, { type AtRule, type Root, type Rule } from "postcss";
import prefixSelector from "postcss-prefix-selector";

import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import type { MiragonRendererSpec } from "../src/notations/miragon/spec.ts";
import { vendorCssScoping, vendorSheetOf } from "../src/notations/miragon/vendor-css.ts";

const require = createRequire(import.meta.url);

/** the stylesheet a spec's load() imports: the package's one ./assets/*.css export */
function stylesheetOf(spec: MiragonRendererSpec): string {
  const manifest = require.resolve(`${spec.pkg}/package.json`);
  const exports = (JSON.parse(readFileSync(manifest, "utf8")) as { exports: Record<string, string> }).exports;
  const sheets = Object.entries(exports).filter(([key]) => key.startsWith("./assets/") && key.endsWith(".css"));
  assert.equal(sheets.length, 1, `${spec.pkg} exports one stylesheet`);
  return join(dirname(manifest), sheets[0]![1]);
}

/** the renderer's stylesheet as the SPA ships it, scoped by vendor-css.ts */
async function scopedSheet(spec: MiragonRendererSpec): Promise<Root> {
  const from = stylesheetOf(spec);
  return (await postcss([prefixSelector(vendorCssScoping(spec))]).process(readFileSync(from, "utf8"), { from })).root;
}

/** the at-rules around a rule, innermost first */
function atRulesOf(rule: Rule): AtRule[] {
  const out: AtRule[] = [];
  for (let node = rule.parent; node && node.type !== "root"; node = node.parent) {
    if (node.type === "atrule") out.push(node as AtRule);
  }
  return out;
}

/** the custom-property families a rule declares (--cd-ui-text → --cd-*) */
function familiesOf(rule: Rule): string[] {
  const families = new Set<string>();
  rule.walkDecls(/^--/, (decl) => void families.add(`--${decl.prop.slice(2).split("-")[0]}-*`));
  return [...families].sort();
}

/**
 * What the scoping leaves without the canvas host class, in sheet order: the
 * selector, the cascade layer it sits in (a renderer's tokens lose to
 * ui-kit's unlayered ones only from inside a layer) and the custom-property
 * families it declares.
 */
async function unscoped(spec: MiragonRendererSpec): Promise<string[]> {
  const scope = `.${spec.canvasClassName}`;
  const global = new Set<string>();
  (await scopedSheet(spec)).walkRules((rule) => {
    const around = atRulesOf(rule);
    if (around.some((at) => /keyframes$/i.test(at.name))) return;
    const layer = around.find((at) => at.name === "layer");
    const families = familiesOf(rule);
    for (const selector of rule.selectors) {
      if (selector.includes(scope)) continue;
      global.add(
        `${layer ? `@layer ${layer.params} ` : ""}${selector}${families.length ? ` { ${families.join(", ")} }` : ""}`,
      );
    }
  });
  return [...global];
}

/** the design-system tokens a 1.13 sheet vendors, and their light-only and
 *  dark-only helper classes, all inside the renderer's own cascade layer */
const tokensIn = (layer: string): string[] => [
  `@layer ${layer} :root { --cd-* }`,
  `@layer ${layer} :root:not([data-cd-theme=dark]):not([data-cd-theme=system]) .cd-nur-dunkel`,
  `@layer ${layer} :root .cd-nur-dunkel`,
  `@layer ${layer} :root[data-cd-theme=system] .cd-nur-dunkel`,
  `@layer ${layer} :root[data-cd-theme=dark] .cd-nur-hell`,
  `@layer ${layer} :root[data-cd-theme=system] .cd-nur-hell`,
];

/**
 * Global on purpose, per renderer. All of them start with :root, the one
 * exemption of the scoping, and none changes what designIQ shows today:
 *
 * - `@layer <renderer>-tokens :root { --cd-* }` and the `.cd-nur-*`
 *   helpers: in a layer, ui-kit's unlayered --cd-* win on every name both
 *   define, and no designIQ markup uses the helpers.
 * - Team Topology 0.10 `:root { --cd-* }`, unlayered: ui-kit's own names
 *   and values, only minified (checked below). Unlayered tokens with other
 *   values override the app's own, as team-topologies-renderer 0.11.0's and
 *   0.11.1's do (their warning and success text fail contrast), so Team
 *   Topology waits for a release that puts its tokens in a layer.
 * - `:root { --bio-* }`, unlayered: maps diagram-js's own --bio-* onto the
 *   design-system roles. bpmn-js and dmn-js read them inside
 *   .bio-theme-parent only, where lib/bpmn-io-theme.css sets its own.
 * - `:root[data-cd-kontrast=hoch] …`: high contrast for the renderer's own
 *   chrome; designIQ never sets data-cd-kontrast. Event Storming's palette
 *   rule would restyle the bpmn-js palette too if it did.
 */
const KNOWN_GLOBAL: Record<string, string[]> = {
  wardley: [...tokensIn("wardley-tokens"), ":root { --bio-* }"],
  "team-topology": [":root { --cd-* }"],
  "event-storming": [
    ...tokensIn("event-storming-tokens"),
    ":root { --bio-* }",
    ":root[data-cd-kontrast=hoch] .djs-palette:not([data-chrome=palette])",
    ":root[data-cd-kontrast=hoch] .djs-hover-tooltip",
    ":root[data-cd-kontrast=hoch] .event-storming-container .djs-context-pad.open",
    ":root[data-cd-kontrast=hoch] .event-storming-container .event-storming-label-input",
    ":root[data-cd-kontrast=hoch] .event-storming-container .event-storming-note-toolbar",
    ":root[data-cd-kontrast=hoch] .event-storming-container .event-storming-color-picker",
    ":root[data-cd-kontrast=hoch] .event-storming-shortcuts",
    ":root[data-cd-kontrast=hoch] .event-storming-shortcuts-close:focus-visible",
  ],
  "context-map": [
    ...tokensIn("context-maps-tokens"),
    ":root { --bio-* }",
    ":root[data-cd-kontrast=hoch] .cm-dialog",
    ":root[data-cd-kontrast=hoch] .cm-dialog-button",
    ":root[data-cd-kontrast=hoch] .cm-dialog-close:focus-visible",
    ":root[data-cd-kontrast=hoch] .cm-dialog-button:focus-visible",
    ":root[data-cd-kontrast=hoch] .cm-dialog-input:focus-visible",
  ],
};

test("the scoping keys on each renderer's own files, as pnpm's store spells them", () => {
  for (const spec of MIRAGON_RENDERERS) {
    const sheet = stylesheetOf(spec);
    assert.match(sheet, vendorSheetOf(spec.pkg), spec.id);
    assert.ok(!MIRAGON_RENDERERS.some((other) => other !== spec && vendorSheetOf(other.pkg).test(sheet)), spec.id);
  }
});

for (const spec of MIRAGON_RENDERERS) {
  test(`${spec.id}: only the reviewed selectors stay global`, async () => {
    assert.deepEqual(await unscoped(spec), KNOWN_GLOBAL[spec.id]);
  });
}

/**
 * One spelling per token value: the renderer sheets come minified (#fff,
 * #0b7a551f, .15s, cubic-bezier(.4, 0, .2, 1)), ui-kit's vendored file does
 * not (#FFFFFF, rgba(11, 122, 85, 0.12), 150ms). Colours become rgba() with
 * the alpha to two places, the precision both spellings carry.
 */
function canonicalValue(value: string): string {
  const rgba = (r: number, g: number, b: number, a: number): string =>
    `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(2))})`;
  return value
    .toLowerCase()
    .replace(
      /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/g,
      (_, r: string, g: string, b: string, a?: string) =>
        rgba(Number(r), Number(g), Number(b), a === undefined ? 1 : Number(a)),
    )
    .replace(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/g, (_, hex: string) => {
      const digits = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
      const [r = 0, g = 0, b = 0, a = 255] = (digits.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
      return rgba(r, g, b, a / 255);
    })
    .replace(
      /(\d*\.?\d+)(m?s)\b/g,
      (_, amount: string, unit: string) => `${Math.round(Number(amount) * (unit === "s" ? 1000 : 1))}ms`,
    )
    .replace(/(^|[^\d.])\.(\d)/g, (_, before: string, digit: string) => `${before}0.${digit}`)
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/** the --cd-* values the app sets itself: ui-kit's tokens.css and the
 *  design-system file it imports, all unlayered */
function appTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  const read = (file: string): void => {
    const root = postcss.parse(readFileSync(file, "utf8"), { from: file });
    root.walkAtRules("import", (at) => read(join(dirname(file), at.params.replace(/^["']|["']$/g, ""))));
    root.walkDecls(/^--cd-/, (decl) => void tokens.set(decl.prop, canonicalValue(decl.value)));
  };
  read(require.resolve("@designiq/ui-kit/tokens.css"));
  return tokens;
}

/** the --cd-* tokens a renderer sets on :root outside any cascade layer */
async function unlayeredTokens(spec: MiragonRendererSpec): Promise<Record<string, string>> {
  const tokens: Record<string, string> = {};
  (await scopedSheet(spec)).walkRules((rule) => {
    if (!rule.selectors.includes(":root") || atRulesOf(rule).some((at) => at.name === "layer")) return;
    rule.walkDecls(/^--cd-/, (decl) => void (tokens[decl.prop] = canonicalValue(decl.value)));
  });
  return tokens;
}

test("token values compare across spellings, and only across spellings", () => {
  assert.equal(canonicalValue("#0b7a551f"), canonicalValue("rgba(11, 122, 85, 0.12)"));
  assert.equal(canonicalValue("#fff"), canonicalValue("#FFFFFF"));
  assert.equal(canonicalValue(".15s"), canonicalValue("150ms"));
  assert.equal(canonicalValue("cubic-bezier(.4,0,.2,1)"), canonicalValue("cubic-bezier(0.4, 0, 0.2, 1)"));
  assert.equal(
    canonicalValue("0 1px 2px #1d1d1d0f, 0 1px 3px #1d1d1d1a"),
    canonicalValue("0 1px 2px rgba(29, 29, 29, 0.06), 0 1px 3px rgba(29, 29, 29, 0.10)"),
  );
  assert.notEqual(canonicalValue("#ffb000"), canonicalValue("#92610A"));
  assert.notEqual(canonicalValue("#0b7a551f"), canonicalValue("rgba(11, 122, 85, 0.2)"));
});

const APP_TOKENS = appTokens();

for (const spec of MIRAGON_RENDERERS) {
  test(`${spec.id}: the tokens it sets unlayered are ui-kit's, value for value`, async () => {
    const own = await unlayeredTokens(spec);
    assert.deepEqual(own, Object.fromEntries(Object.keys(own).map((name) => [name, APP_TOKENS.get(name)])));
  });
}
