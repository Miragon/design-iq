/**
 * The SPA's scoping of the Miragon renderer stylesheets
 * (src/notations/miragon/vendor-css.ts), run over the sheets apps/web pins:
 * which selectors it leaves global. A global selector applies to the whole
 * app once a renderer's chunk has loaded, bpmn-js and dmn-js included, so
 * each one is listed here with the reason it may stay, and a renderer bump
 * that adds one fails until it is reviewed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

import postcss, { type AtRule, type Rule } from "postcss";
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
  const from = stylesheetOf(spec);
  const result = await postcss([prefixSelector(vendorCssScoping(spec))]).process(readFileSync(from, "utf8"), { from });
  const scope = `.${spec.canvasClassName}`;
  const global = new Set<string>();
  result.root.walkRules((rule) => {
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
 * - Team Topology 0.10 `:root { --cd-* }`, unlayered: the same values ui-kit
 *   vendors. Unlayered tokens with other values override the app's own, as
 *   team-topologies-renderer 0.11.0's do (its warning and success text fail
 *   contrast), so Team Topology waits for its layered 0.11.1.
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
