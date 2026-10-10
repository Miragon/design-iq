/**
 * Drift + contrast guard for the CI token layer.
 *
 * 1. lib/tokens.ts `CD` mirrors the vendored cd-tokens.generated.css — re-copy
 *    the file from the skill with a changed value and this fails until the
 *    mirror follows.
 * 2. lib/tokens.ts `ALIASES` mirrors tokens.css — the test EVALUATES every
 *    alias (var() chains, color-mix() in srgb) and compares the result.
 * 3. tokens.css stays on the CI: no literal colour of its own, only --cd-*
 *    tokens and color-mix() of them, and one mode (no scheme override).
 * 4. The opaque status tints (--*-soft) are the CI's --cd-*-soft over the
 *    ground — a CI release that changes the tint fails until tokens.css follows.
 * 5. WCAG contrast: text ≥ 4.5:1, non-text ≥ 3:1.
 *
 * Every other --cd-* name the platform references (radius, shadow, motion…)
 * is guarded by test/cd-references.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ALIASES,
  type AliasToken,
  CD_TOKENS,
  FONT_MONO,
  FONT_SANS,
  mixRgba,
  parseColor,
  type Rgba,
} from "../src/lib/tokens.ts";

const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const vendored = read("cd-tokens.generated.css");
const tokensCss = read("tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** `--name: value;` declarations of the block opened by `selector {` */
function declarations(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no "${selector} {" block`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

const cdVars = declarations(vendored, ":root");
const aliasVars = declarations(tokensCss, ":root");

/** evaluate a colour expression the way the browser does for these sheets */
function evaluate(expr: string, depth = 0): Rgba {
  assert.ok(depth < 10, `var() cycle at ${expr}`);
  const e = expr.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(e)?.[1];
  if (ref) {
    const value = aliasVars.get(ref) ?? cdVars.get(ref);
    assert.ok(value, `undefined ${ref}`);
    return evaluate(value, depth + 1);
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(e);
  if (mix) return mixRgba(evaluate(mix[1]!, depth + 1), Number(mix[2]), evaluate(mix[3]!, depth + 1));
  return parseColor(e);
}

/** a translucent colour composited over its surface, as rendered */
const over = (fg: Rgba, bg: Rgba): Rgba => mixRgba([fg[0], fg[1], fg[2], 1], fg[3] * 100, bg);
const near = (a: Rgba, b: Rgba) => a.every((v, i) => Math.abs(v - b[i]!) <= (i === 3 ? 0.01 : 1));
const show = ([r, g, b, a]: Rgba) => `rgba(${r.toFixed(1)}, ${g.toFixed(1)}, ${b.toFixed(1)}, ${a.toFixed(2)})`;

describe("tokens.ts mirrors the vendored CI tokens", () => {
  it("declares every mirrored --cd-* colour with the vendored value", () => {
    for (const [name, value] of Object.entries(CD_TOKENS)) {
      assert.equal(cdVars.get(name)?.toLowerCase(), value.toLowerCase(), name);
    }
  });
});

describe("tokens.ts mirrors tokens.css", () => {
  it("every alias evaluates to its ALIASES value", () => {
    for (const [name, expected] of Object.entries(ALIASES)) {
      const declared = aliasVars.get(`--${name}`);
      assert.ok(declared, `--${name} missing in tokens.css`);
      const got = evaluate(declared);
      const want = parseColor(expected);
      assert.ok(near(got, want), `--${name}: css ${show(got)} vs ts ${show(want)}`);
    }
  });

  it("declares no alias the mirror lacks", () => {
    const colourAliases = [...aliasVars.keys()].filter((k) => !k.startsWith("--designiq-font-")).sort();
    assert.deepEqual(
      colourAliases,
      Object.keys(ALIASES)
        .map((k) => `--${k}`)
        .sort(),
    );
  });

  it("names the same font stacks", () => {
    assert.equal(aliasVars.get("--designiq-font-sans"), FONT_SANS);
    assert.equal(aliasVars.get("--designiq-font-mono"), FONT_MONO);
  });

  it("adds no colour of its own — only --cd-* tokens and color-mix() of them", () => {
    assert.deepEqual(tokensCss.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/gi) ?? [], []);
  });

  it("has one mode, as the CI prescribes", () => {
    assert.match(tokensCss, /color-scheme:\s*light;/);
    assert.doesNotMatch(tokensCss, /\.dark\b|prefers-color-scheme|data-theme/);
  });
});

describe("the status tints", () => {
  const SOFT = {
    "success-soft": "--cd-success-soft",
    "warning-soft": "--cd-warning-soft",
    "destructive-soft": "--cd-danger-soft",
  };

  it("are the CI's --cd-*-soft composited over the background", () => {
    for (const [alias, cd] of Object.entries(SOFT) as [AliasToken, string][]) {
      const ci = cdVars.get(cd);
      assert.ok(ci, `${cd} missing in the vendored sheet`);
      const want = over(parseColor(ci), parseColor(ALIASES.background));
      const got = parseColor(ALIASES[alias]);
      assert.ok(near(got, want), `--${alias}: ${show(got)} vs CI ${cd} over the background ${show(want)}`);
    }
  });

  it("are opaque — a selected or hovered row underneath must not darken them", () => {
    for (const alias of Object.keys(SOFT) as AliasToken[]) assert.equal(parseColor(ALIASES[alias])[3], 1, alias);
  });
});

/** WCAG 2 relative luminance + contrast ratio */
function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg: Rgba, bg: Rgba): number {
  const [a, b] = [luminance(over(fg, bg)), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** bg: one surface, or a stack of layers top-first, composited down to an opaque ground */
type Pair = [fg: AliasToken, bg: AliasToken | AliasToken[]];
const TEXT: Pair[] = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "secondary"],
  ["primary-foreground", "primary"],
  ["primary-foreground", "primary-hover"],
  ["destructive-foreground", "destructive"],
  ["destructive", "background"],
  ["success", "background"],
  ["warning", "background"],
  // status text on its tint: badges, banners, the destructive hover…
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["destructive", "destructive-soft"],
  // …and a status badge in a selected (accent) or hovered (muted) row
  ["success", ["success-soft", "accent", "background"]],
  ["warning", ["warning-soft", "accent", "background"]],
  ["success", ["success-soft", "muted"]],
  ["warning", ["warning-soft", "muted"]],
  ["info", "background"],
  ["link", "background"],
  ["link", "secondary"],
  // a highlighted menu entry: the accent tint over the popover
  ["accent-foreground", ["accent", "popover"]],
  ["canvas-label", "canvas-shape"],
  ["canvas-label", "canvas-background"],
];
const NON_TEXT: Pair[] = [
  ["input", "background"],
  ["ring", "background"],
  ["primary", "background"],
  ["canvas-stroke", "canvas-background"],
  ["canvas-accent", "canvas-background"],
];

describe("WCAG contrast", () => {
  const color = (t: AliasToken) => parseColor(ALIASES[t]);
  const surface = (bg: Pair[1]) => {
    const [ground, ...layers] = (Array.isArray(bg) ? bg : [bg]).map(color).reverse();
    assert.equal(ground![3], 1, `${String(bg)}: the ground of a surface must be opaque`);
    return layers.reduce((under, layer) => over(layer, under), ground!);
  };
  const check = (pairs: Pair[], min: number) => () => {
    for (const [fg, bg] of pairs) {
      const ratio = contrast(color(fg), surface(bg));
      assert.ok(ratio >= min, `${fg} on ${String(bg)} is ${ratio.toFixed(2)}:1 (< ${min}:1)`);
    }
  };
  it("text ≥ 4.5:1", check(TEXT, 4.5));
  it("non-text ≥ 3:1", check(NON_TEXT, 3));
});
