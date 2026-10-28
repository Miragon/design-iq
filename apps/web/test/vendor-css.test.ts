/**
 * The SPA's scoping of the Miragon renderer stylesheets
 * (src/notations/miragon/vendor-css.ts), run over the sheets apps/web pins:
 * which selectors it leaves global. A global selector applies to the whole
 * app once a renderer's chunk has loaded, bpmn-js and dmn-js included, so
 * each one is listed here with the reason it may stay, and a renderer bump
 * that adds one fails until it is reviewed. Every other rule is scoped as a
 * descendant of the canvas host, the renderer's own root rules included
 * (the contract factories mount that root inside the host). The --cd-*
 * tokens a sheet sets on :root outside a cascade layer override the app's
 * own, so they must be ui-kit's, value for value: a bump that changes one
 * fails as well.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

/** the renderer's stylesheet (or `css` in its place) as the SPA ships it, scoped by vendor-css.ts */
async function scopedSheet(spec: MiragonRendererSpec, css?: string): Promise<Root> {
  const from = stylesheetOf(spec);
  return (await postcss([prefixSelector(vendorCssScoping(spec))]).process(css ?? readFileSync(from, "utf8"), { from }))
    .root;
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
 *   define, and no designIQ markup uses the helpers. Team Topology has them
 *   in a layer since 0.11.2; 0.11.0 and 0.11.1 set them unlayered, which the
 *   value check below refuses.
 * - `:root { --bio-* }`, unlayered: maps diagram-js's own --bio-* onto the
 *   design-system roles. bpmn-js and dmn-js read them inside
 *   .bio-theme-parent only, where lib/bpmn-io-theme.css sets its own. Every
 *   renderer declares the same mapping (checked below), so the order in
 *   which their chunks load never changes it.
 * - `:root[data-cd-kontrast=hoch] …`: high contrast for the renderer's own
 *   chrome; designIQ never sets data-cd-kontrast. Event Storming's palette
 *   rule would restyle the bpmn-js palette too if it did.
 */
const KNOWN_GLOBAL: Record<string, string[]> = {
  wardley: [...tokensIn("wardley-tokens"), ":root { --bio-* }"],
  "team-topology": [...tokensIn("team-topologies-tokens"), ":root { --bio-* }"],
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
  "value-chain": [
    ...tokensIn("value-chain-tokens"),
    ":root { --bio-* }",
    ":root[data-cd-kontrast=hoch] .vc-container .djs-context-pad.open",
    ":root[data-cd-kontrast=hoch] .vc-container .djs-direct-editing-parent",
    ":root[data-cd-kontrast=hoch] .vc-shortcuts",
    ":root[data-cd-kontrast=hoch] .vc-shortcuts-close:focus-visible",
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

/** the root element each renderer's factory mounts inside the canvas host */
const RENDERER_ROOT: Record<string, string> = {
  wardley: "wardley-container",
  "team-topology": "tt-djs-container",
  "event-storming": "event-storming-container",
  "context-map": "cm-djs-container",
  "value-chain": "vc-container",
};

/**
 * The rules of the renderer's own root as the SPA ships them, one entry per
 * root state in any order (what follows the root is left out): the canvas
 * host class, a space, the root. They match because the root is a CHILD of
 * the host (test/miragon-renderers.test.ts mounts the real factories); scoped
 * as a compound on the host, as before the factories, they match nothing and
 * the canvas loses its paper, dot grid, focus ring and label editor styles.
 * designIQ's own rules on a root (src/index.css) are held to the same form.
 */
const ROOT_RULES: Record<string, string[]> = {
  wardley: [
    ".wardley-canvas .wardley-container",
    ".wardley-canvas .wardley-container.wardley-draw-mode",
    ".wardley-canvas .wardley-container.wardley-labels-draggable",
    ".wardley-canvas .wardley-container.wardley-label-dragging",
    ".wardley-canvas .wardley-container.wardley-read-only",
  ],
  "team-topology": [
    ".tt-canvas .tt-djs-container",
    ".tt-canvas .tt-djs-container:focus",
    ".tt-canvas .tt-djs-container:focus-visible",
  ],
  "event-storming": [
    ".es-canvas .event-storming-container",
    ".es-canvas .event-storming-container.event-storming-draw-mode",
  ],
  "context-map": [".cm-canvas .cm-djs-container", ".cm-canvas .cm-djs-container:focus"],
  "value-chain": [".vc-canvas .vc-container"],
};

/** the root rules of the scoped sheet, sorted; every scoped rule must be a descendant of the host */
async function rootRulesOf(spec: MiragonRendererSpec, css?: string): Promise<string[]> {
  const scope = `.${spec.canvasClassName} `;
  const root = `.${RENDERER_ROOT[spec.id]}`;
  const heads = new Set<string>();
  (await scopedSheet(spec, css)).walkRules((rule) => {
    for (const selector of rule.selectors) {
      if (selector.startsWith(":root") || atRulesOf(rule).some((at) => /keyframes$/i.test(at.name))) continue;
      assert.ok(selector.startsWith(scope), selector);
      const rest = selector.slice(scope.length);
      if (rest.startsWith(root) && /^($|[ .:>~+[])/.test(rest.slice(root.length))) {
        heads.add(scope + rest.split(/[\s>~+]/)[0]);
      }
    }
  });
  return [...heads].sort();
}

for (const spec of MIRAGON_RENDERERS) {
  test(`${spec.id}: every scoped rule is a descendant of the canvas host, the renderer's root rules included`, async () => {
    assert.ok(RENDERER_ROOT[spec.id], `${spec.id}: the root its factory mounts is named`);
    const expected = [...(ROOT_RULES[spec.id] ?? [])].sort();
    assert.deepEqual(await rootRulesOf(spec), expected);
    // a renderer bump that only reorders its sheet changes nothing to review
    const reordered = postcss.parse(readFileSync(stylesheetOf(spec), "utf8"));
    reordered.nodes.reverse();
    assert.deepEqual(await rootRulesOf(spec, reordered.toString()), expected, "the sheet in reverse order");
  });
}

/** designIQ's own stylesheets: the SPA's and the widgets' */
function ownStylesheets(): string[] {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".css"))
    .map((file) => join(src, file));
}

test("designIQ's own rules on a renderer's root name it as a descendant of the canvas host, never as a compound with it", () => {
  let named = 0;
  for (const file of ownStylesheets()) {
    postcss.parse(readFileSync(file, "utf8"), { from: file }).walkRules((rule) => {
      for (const selector of rule.selectors) {
        for (const spec of MIRAGON_RENDERERS) {
          const root = `\\.${RENDERER_ROOT[spec.id]}(?![\\w-])`;
          named += selector.match(new RegExp(root, "g"))?.length ?? 0;
          assert.doesNotMatch(selector, new RegExp(`(?<!\\.${spec.canvasClassName} )${root}`), `${file}: ${selector}`);
        }
      }
    });
  }
  assert.ok(named > 0, "src/index.css keeps the Team Topologies palette below the SPA's empty top strip");
});

/** the palette properties lib/value-chain-palette.css sets for a host without the shell's chrome */
const PALETTE_LAYOUT = new Set(["display", "flex-direction", "top", "left", "transform", "width", "float"]);

test("value-chain: the renderer lays out no palette outside the shell's chrome, so designIQ's own sheet does (guide §5.5)", async () => {
  const spec = MIRAGON_RENDERERS.find((s) => s.id === "value-chain")!;
  const outsideChrome: string[] = [];
  (await scopedSheet(spec)).walkRules((rule) => {
    if (!rule.selectors.some((selector) => selector.includes(".djs-palette:not([data-chrome=palette])"))) return;
    rule.walkDecls(
      (decl) => void (PALETTE_LAYOUT.has(decl.prop) && outsideChrome.push(`${rule.selector} { ${decl.prop} }`)),
    );
  });
  // a release that lays its palette out itself makes lib/value-chain-palette.css redundant: drop it then
  assert.deepEqual(outsideChrome, []);
  const sheets = ["../src/index.css", "../src/mcp-app/miragon-styles.css"].map((path) =>
    readFileSync(new URL(path, import.meta.url), "utf8"),
  );
  for (const sheet of sheets) assert.match(sheet, /@import "[./]*\/?lib\/value-chain-palette\.css";/);
});

test("value-chain: every role and shell measure lib/value-chain-palette.css reads is declared by the renderer's own sheet", () => {
  // ui-kit's vendored sheet predates both families (packages/ui-kit/test/cd-references.test.ts lists this file),
  // so the renderer's token layer is the one place they come from
  const spec = MIRAGON_RENDERERS.find((s) => s.id === "value-chain")!;
  const declared = new Set(
    [...readFileSync(stylesheetOf(spec), "utf8").matchAll(/(--cd-(?:ui|shell)-[\w-]+)\s*:/g)].map((m) => m[1]!),
  );
  const sheet = readFileSync(new URL("../src/lib/value-chain-palette.css", import.meta.url), "utf8");
  const read = new Set([...sheet.matchAll(/var\(\s*(--cd-(?:ui|shell)-[\w-]+)/g)].map((m) => m[1]!));
  assert.ok(read.size >= 8, "the sheet reads the renderer's roles");
  assert.deepEqual(
    [...read].filter((name) => !declared.has(name)),
    [],
  );
});

/** the declarations of the unlayered `:root` rules that set --bio-* */
async function bioMapping(spec: MiragonRendererSpec): Promise<string[]> {
  const declarations: string[] = [];
  (await scopedSheet(spec)).walkRules((rule) => {
    if (!rule.selectors.includes(":root") || atRulesOf(rule).some((at) => at.name === "layer")) return;
    if (!rule.some((node) => node.type === "decl" && node.prop.startsWith("--bio-"))) return;
    rule.walkDecls((decl) => void declarations.push(`${decl.prop}: ${decl.value}`));
  });
  return declarations;
}

test("every renderer maps --bio-* the same way, so no load order changes it", async () => {
  const [first, ...others] = MIRAGON_RENDERERS;
  const mapping = await bioMapping(first!);
  assert.ok(mapping.length > 0);
  for (const spec of others) assert.deepEqual(await bioMapping(spec), mapping, spec.id);
});

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

/** the --cd-* tokens a scoped sheet sets on :root outside any cascade layer */
function unlayeredTokens(sheet: Root): Record<string, string> {
  const tokens: Record<string, string> = {};
  sheet.walkRules((rule) => {
    if (!rule.selectors.includes(":root") || atRulesOf(rule).some((at) => at.name === "layer")) return;
    rule.walkDecls(/^--cd-/, (decl) => void (tokens[decl.prop] = canonicalValue(decl.value)));
  });
  return tokens;
}

/** what ui-kit sets each of `own`'s names to (undefined: not one of its tokens) */
function uiKitValuesOf(own: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(own).map((name) => [name, APP_TOKENS.get(name)]));
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
    const own = unlayeredTokens(await scopedSheet(spec));
    assert.deepEqual(own, uiKitValuesOf(own));
  });
}

/** a sheet with its cascade layers dissolved: their rules stand where the layer stood */
function withoutLayers(css: string): string {
  const sheet = postcss.parse(css);
  sheet.walkAtRules("layer", (at) => {
    if (at.nodes) at.replaceWith(at.nodes);
  });
  return sheet.toString();
}

test("a token sheet without its layer fails the value check: team-topologies-renderer 0.11.1's overrode the status colours", async () => {
  // 0.11.2's stylesheet without its layer is byte for byte 0.11.1's
  const spec = MIRAGON_RENDERERS.find((s) => s.id === "team-topology")!;
  const unlayered = unlayeredTokens(await scopedSheet(spec, withoutLayers(readFileSync(stylesheetOf(spec), "utf8"))));
  const uiKit = uiKitValuesOf(unlayered);
  assert.notDeepEqual(unlayered, uiKit);
  for (const name of ["--cd-success", "--cd-warning", "--cd-danger", "--cd-info"]) {
    assert.ok(uiKit[name], name);
    assert.notEqual(unlayered[name], uiKit[name], name);
  }
  assert.equal(unlayered["--cd-warning"], canonicalValue("#ffb000"));
});
