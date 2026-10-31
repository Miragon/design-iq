/**
 * Reference integrity for the vendored CI sheet: every `var(--cd-*)` the
 * platform uses must be DECLARED in cd-tokens.generated.css. tokens.test.ts
 * pins the colours by value; radius, shadow, motion, spacing and the -soft
 * tints are referenced by name only — and a var() naming a token the sheet
 * lacks is invalid at computed-value time, silently: `rounded-md` falls to 0,
 * `shadow-lg` to none, a transition to `ease`. Re-copying a CI release that
 * renamed or dropped one of them fails here instead.
 *
 * Scanned: the kit (packages/ui-kit/src), the SPA and the MCP-App widgets
 * (apps/web/src, apps/web/*.html) — all of them load the sheet through
 * tokens.css. The Live Host's own pages cannot (src/http/brand-page.ts): they
 * declare their copies inline, so there every reference must be declared in
 * the page itself, under a name the CI has (the values are pinned by
 * apps/live-host/test/brand-page.test.ts).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** `--cd-name:` declarations */
const declared = (css: string) => new Set([...css.matchAll(/(--cd-[\w-]+)\s*:/g)].map((m) => m[1]!));
/** `var(--cd-name` and Tailwind's `-(--cd-name)` shorthand */
const referenced = (src: string) =>
  new Set([...src.matchAll(/var\(\s*(--cd-[\w-]+)|-\((--cd-[\w-]+)\)/g)].map((m) => (m[1] ?? m[2])!));

const ci = declared(read("packages/ui-kit/src/cd-tokens.generated.css"));

/** repo-relative paths of the files under `dir` (recursive) with one of `exts` */
const files = (dir: string, exts: RegExp, recursive = true) =>
  readdirSync(new URL(dir, root), { recursive })
    .map(String)
    .filter((f) => exts.test(f) && !f.includes("node_modules"))
    .map((f) => `${dir}${f}`);

/** every `file → name` whose name the CI sheet does not declare */
function undeclared(paths: string[], known: Set<string>): { refs: number; missing: string[] } {
  let refs = 0;
  const missing: string[] = [];
  for (const path of paths) {
    for (const name of referenced(read(path))) {
      refs++;
      if (!known.has(name)) missing.push(`${path} → ${name}`);
    }
  }
  return { refs, missing };
}

describe("every referenced --cd-* token is declared in cd-tokens.generated.css", () => {
  it("sanity: the vendored sheet parses", () => {
    assert.ok(ci.size >= 30, `only ${ci.size} --cd-* declarations found`);
  });

  for (const [scope, paths] of [
    ["packages/ui-kit/src", files("packages/ui-kit/src/", /\.(css|tsx?)$/)],
    ["apps/web/src", files("apps/web/src/", /\.(css|tsx?)$/)],
    ["apps/web/*.html", files("apps/web/", /^[^/]+\.html$/, false)],
  ] as const) {
    it(scope, () => {
      const { refs, missing } = undeclared(paths, ci);
      // the HTML entries carry no reference today — a scope that never matches
      // anything is only a broken path for the source trees
      if (scope !== "apps/web/*.html") assert.ok(refs > 0, `${scope}: no var(--cd-*) found — wrong path?`);
      assert.deepEqual(missing, [], "referenced but not declared by the CI");
    });
  }

  it("apps/live-host/src/http/brand-page.ts declares what it uses, under CI names", () => {
    const path = "apps/live-host/src/http/brand-page.ts";
    const own = declared(read(path));
    assert.ok(own.size > 0, "the page declares its tokens");
    assert.deepEqual(
      [...own].filter((name) => !ci.has(name)),
      [],
      "declared under a name the CI does not have",
    );
    const { refs, missing } = undeclared([path], own);
    assert.ok(refs > 0, "the page uses its tokens");
    assert.deepEqual(missing, [], "used but not declared in the page (it cannot load the CI sheet)");
  });
});
