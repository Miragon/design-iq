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
 * - `:root { --cdc-* }`, unlayered: the underlays of the guide's canvas
 *   classes (cd-canvas.css, guide 1.27.0), `none` in light mode. Only the
 *   renderers' own .cd-c-unterleger* classes read them, and every renderer
 *   declares the same values (checked below).
 *
 * The high-contrast rules of the renderers' chrome sit in
 * `@scope ([data-cd-kontrast=hoch])` blocks, which the scoping prefixes like
 * every other rule, so none of them is left global (designIQ never sets
 * data-cd-kontrast).
 */
const KNOWN_GLOBAL: Record<string, string[]> = {
  wardley: [...tokensIn("wardley-tokens"), ":root { --cdc-* }", ":root { --bio-* }"],
  "team-topology": [...tokensIn("team-topologies-tokens"), ":root { --cdc-* }", ":root { --bio-* }"],
  "event-storming": [...tokensIn("event-storming-tokens"), ":root { --cdc-* }", ":root { --bio-* }"],
  "context-map": [...tokensIn("context-maps-tokens"), ":root { --cdc-* }", ":root { --bio-* }"],
  "value-chain": [...tokensIn("value-chain-tokens"), ":root { --cdc-* }", ":root { --bio-* }"],
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
    // the text colour of a root that carries the theme the appearance surface sets
    ".wardley-canvas .wardley-container[data-cd-theme]",
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
  assert.ok(named > 0, "src/index.css keeps the narrow canvas's palettes out of the SPA's empty top strip");
});

/** whether a renderer's sheet moves its palette down in a narrow canvas: a row kept free for a host's top chrome */
function dropsPaletteWhenNarrow(spec: MiragonRendererSpec): boolean {
  let drops = false;
  postcss.parse(readFileSync(stylesheetOf(spec), "utf8")).walkAtRules("container", (at) => {
    if (!/width\s*<=\s*760px/.test(at.params)) return;
    at.walkRules((rule) => {
      if (rule.selectors.some((selector) => /\.djs-palette(?![\w-])/.test(selector)) && rule.some(isTop)) drops = true;
    });
  });
  return drops;
}

const isTop = (node: postcss.ChildNode): boolean => node.type === "decl" && node.prop === "top";

test("src/index.css keeps at the top of the SPA's canvas, which has no chrome over it, exactly the palettes a renderer drops in a narrow canvas", () => {
  const index = fileURLToPath(new URL("../src/index.css", import.meta.url));
  const atTop = new Set<string>();
  postcss.parse(readFileSync(index, "utf8"), { from: index }).walkRules((rule) => {
    if (!rule.some((node) => isTop(node) && (node as postcss.Declaration).value === "12px")) return;
    for (const selector of rule.selectors) atTop.add(selector);
  });
  for (const spec of MIRAGON_RENDERERS) {
    // the id outranks the renderer's scoped rule, which loads after index.css
    const lifted = atTop.has(
      `#root .${spec.canvasClassName} .${RENDERER_ROOT[spec.id]} .djs-palette:not([data-chrome="palette"])`,
    );
    assert.equal(lifted, dropsPaletteWhenNarrow(spec), spec.id);
  }
});

/** a selector only for the palette the modeler shell skins, which designIQ never mounts */
const shellPaletteOnly = (selector: string): boolean => /(?<!:not\()\[data-chrome="?palette"?\]/.test(selector);

/** whether a renderer's sheet undoes diagram-js's 94px two-column clamp for its own palette, as designIQ shows it */
function liftsTwoColumnClamp(spec: MiragonRendererSpec): boolean {
  let lifts = false;
  postcss.parse(readFileSync(stylesheetOf(spec), "utf8")).walkRules((rule) => {
    const clamp = (selector: string) =>
      /\.djs-palette.*\.two-column\.open/.test(selector) && !shellPaletteOnly(selector);
    if (!rule.selectors.some(clamp)) return;
    rule.walkDecls("width", (decl) => void (lifts ||= decl.value !== "94px"));
  });
  return lifts;
}

test("every renderer undoes diagram-js's two-column clamp for its own palette, so a canvas shorter than the tools keeps them all inside its one row", () => {
  assert.deepEqual(
    MIRAGON_RENDERERS.filter((spec) => !liftsTwoColumnClamp(spec)).map((spec) => spec.id),
    [],
  );
});

/** a selector on a palette in diagram-js's two-column layout, with or without .open: a width there undoes the 94px clamp */
const onTwoColumnPalette = (selector: string): boolean =>
  /\.djs-palette.*(?<!:not\()\.two-column(?![\w-])/.test(selector);

const isWidth = (node: postcss.ChildNode): boolean =>
  node.type === "decl" && /^(min-|max-)?(width|inline-size)$/.test(node.prop);

const widgetSheet = fileURLToPath(new URL("../src/mcp-app/miragon-styles.css", import.meta.url));

test("the widget only places a renderer's palette: its size, its one row and its scrolling stay the renderer's (guide §5.15)", () => {
  const placed = new Set<string>();
  postcss.parse(readFileSync(widgetSheet, "utf8"), { from: widgetSheet }).walkRules((rule) => {
    if (!rule.selectors.some((selector) => /\.djs-palette/.test(selector) && !onTwoColumnPalette(selector))) return;
    rule.walkDecls((decl) => void placed.add(decl.prop));
  });
  assert.deepEqual([...placed].sort(), ["max-width", "top"]);
});

test("no designIQ sheet lifts diagram-js's two-column clamp, but the widget's for a renderer that leaves it", () => {
  const lifted: string[] = [];
  for (const file of ownStylesheets()) {
    postcss.parse(readFileSync(file, "utf8"), { from: file }).walkRules((rule) => {
      const selectors = rule.selectors.filter(onTwoColumnPalette);
      if (selectors.length === 0 || !rule.some(isWidth)) return;
      rule.walkDecls((decl) =>
        assert.equal(`${decl.prop}: ${decl.value}`, "width: max-content", `${file}: ${rule.selector}`),
      );
      lifted.push(...selectors.map((selector) => `${file}: ${selector}`));
    });
  }
  const expected = MIRAGON_RENDERERS.filter((spec) => !liftsTwoColumnClamp(spec)).map(
    (spec) =>
      `${widgetSheet}: #app[data-kind="miragon"] #canvas .${spec.canvasClassName} .${RENDERER_ROOT[spec.id]} .djs-palette.two-column.open`,
  );
  assert.deepEqual(lifted.sort(), expected.sort());
});

/** the declarations of the unlayered `:root` rules that set a family (--bio-, --cdc-) */
async function rootFamily(spec: MiragonRendererSpec, family: string): Promise<string[]> {
  const declarations: string[] = [];
  (await scopedSheet(spec)).walkRules((rule) => {
    if (!rule.selectors.includes(":root") || atRulesOf(rule).some((at) => at.name === "layer")) return;
    if (!rule.some((node) => node.type === "decl" && node.prop.startsWith(family))) return;
    rule.walkDecls((decl) => void declarations.push(`${decl.prop}: ${decl.value}`));
  });
  return declarations;
}

for (const family of ["--bio-", "--cdc-"]) {
  test(`every renderer sets ${family}* on :root the same way, so no load order changes it`, async () => {
    const [first, ...others] = MIRAGON_RENDERERS;
    const declarations = await rootFamily(first!, family);
    assert.ok(declarations.length > 0);
    for (const spec of others) assert.deepEqual(await rootFamily(spec, family), declarations, spec.id);
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

/**
 * The modeler shell's sheet, which each Miragon spec's load() brings for the
 * shell's Keyboard shortcuts… dialog (notations/miragon/menu-content.ts). The SPA
 * does not scope it: the dialog lies in the top layer, and every rule of the
 * sheet keys on a class of the shell's own or on `[data-chrome=palette]`,
 * which only the shell's chrome sets on a palette. So it reaches only the
 * shell's dialog and the rows the renderers draw with the shell's legend
 * classes into designIQ's own Legend panel, where lib/miragon-legend.css'
 * more specific rules set what the shell's set.
 */
const SHELL_SHEET = require.resolve("@miragon/modeler-shell/shell.css");
const shellSheet = postcss.parse(readFileSync(SHELL_SHEET, "utf8"), { from: SHELL_SHEET });

/** the rules of a sheet outside @keyframes */
function rulesOf(sheet: Root): Rule[] {
  const rules: Rule[] = [];
  sheet.walkRules((rule) => {
    if (!atRulesOf(rule).some((at) => /keyframes$/i.test(at.name))) rules.push(rule);
  });
  return rules;
}

test("the modeler shell's sheet styles nothing but the shell's own classes", () => {
  const foreign = rulesOf(shellSheet)
    .flatMap((rule) => rule.selectors)
    .filter((selector) => !/\.cd-shell(?![\w-])|\.cd-shell-[\w-]+|\[data-chrome="?palette"?\]/.test(selector));
  assert.deepEqual(foreign, []);
});

/** the shell's legend classes the renderers' renderLegend draws, and what of
 *  the shell's rules for them designIQ's panel may leave standing */
const LEGEND_CLASSES: Record<string, string[]> = {
  "cd-shell-legend-row": [],
  // designIQ's preview is a flex box: its own align-items wins, justify-items does nothing there
  "cd-shell-legend-preview": ["place-items"],
  // the renderers draw the rule as a div, which has no border to take away
  "cd-shell-legend-separator": ["border"],
};

test("the shell's rules for the legend rows set nothing designIQ's Legend panel does not set itself", () => {
  const legendSheet = postcss.parse(readFileSync(new URL("../src/lib/miragon-legend.css", import.meta.url), "utf8"));
  const propertiesOf = (sheet: Root, selector: string): Set<string> => {
    const properties = new Set<string>();
    for (const rule of rulesOf(sheet)) {
      if (atRulesOf(rule).length > 0 || !rule.selectors.includes(selector)) continue;
      rule.walkDecls((decl) => void properties.add(decl.prop));
    }
    return properties;
  };
  for (const [name, left] of Object.entries(LEGEND_CLASSES)) {
    const shell = propertiesOf(shellSheet, `.${name}`);
    assert.ok(shell.size > 0, `the shell styles .${name}`);
    const own = propertiesOf(legendSheet, `.miragon-legend .${name}`);
    assert.deepEqual(
      [...shell].filter((property) => !own.has(property)),
      left,
      `.miragon-legend .${name}`,
    );
  }
});

test("every --cd-* name the shell's dialog reads is declared by each renderer's sheet or by ui-kit", () => {
  const dialogRule = /\.cd-shell-(?:dialog|shortcuts|kbd)(?![\w-])|\.cd-shell-(?:dialog|shortcuts)-[\w-]+/;
  const read = new Set<string>();
  for (const rule of rulesOf(shellSheet)) {
    if (!rule.selectors.some((selector) => dialogRule.test(selector))) continue;
    rule.walkDecls((decl) => {
      for (const [, name] of decl.value.matchAll(/var\(\s*(--cd-[\w-]+)/g)) read.add(name!);
    });
  }
  assert.ok(read.has("--cd-ui-backdrop") && read.has("--cd-ui-flaeche-hoch"), [...read].join(", "));
  for (const spec of MIRAGON_RENDERERS) {
    const declared = new Set(
      [...readFileSync(stylesheetOf(spec), "utf8").matchAll(/(--cd-[\w-]+)\s*:/g)].map((m) => m[1]!),
    );
    assert.deepEqual(
      [...read].filter((name) => !declared.has(name) && !APP_TOKENS.has(name)),
      [],
      spec.id,
    );
  }
});
