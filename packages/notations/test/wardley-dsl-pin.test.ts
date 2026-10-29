/**
 * extract.ts reads a Wardley Map with @miragon/wardley-dsl because the canvas
 * does: the text writes no ids, the parser derives them from the names, so
 * the ids get_view reports, a todo anchors to and presence outlines are the
 * canvas's only while both parse with one release. The stage a component
 * reports comes from @miragon/wardley-schema-model's boundaries, the ones the
 * canvas's evolution grid draws. The renderer apps/web draws with pins both
 * exactly; a bump of the renderer without these pins (or of a pin alone)
 * would let the two derive different ids or stages (#275): they move in one
 * PR. The validator and the read-only MCP server bundle this package and
 * install its dependencies from npm, so they pin the same releases. Read
 * from the lockfile, whatever apps/web declares itself.
 *
 * extract.ts reads a .storm board itself, the way @miragon/event-storming-dsl
 * does (storm-ids.test.ts compares the two): that devDependency is the
 * release apps/web's @miragon/event-storming-renderer parses with.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parse } from "yaml";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

interface Lockfile {
  importers: Record<string, { dependencies?: Record<string, { version: string }> }>;
  snapshots: Record<string, { dependencies?: Record<string, string> }>;
}
const lock = parse(read("../../../pnpm-lock.yaml")) as Lockfile;

/** "0.7.1(zod@4.6.7)" → "0.7.1": a lockfile version without its peer suffix */
const bare = (version: string | undefined): string | undefined => version?.replace(/\(.*$/, "");

/** the release of `dependency` that apps/web's `renderer` resolves */
function rendererDependency(renderer: string, dependency: string): string {
  const version = lock.importers["apps/web"]?.dependencies?.[renderer]?.version;
  assert.ok(version, `apps/web resolves ${renderer}`);
  const resolved = bare(lock.snapshots[`${renderer}@${version}`]?.dependencies?.[dependency]);
  assert.ok(resolved, `${renderer} depends on ${dependency}`);
  return resolved;
}

const manifest = (
  workspace: string,
): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } =>
  JSON.parse(read(`../../../${workspace}/package.json`));

const WARDLEY_RENDERER = "@miragon/wardley-renderer";

for (const dependency of ["@miragon/wardley-dsl", "@miragon/wardley-schema-model"]) {
  for (const workspace of ["packages/notations", "packages/validator", "packages/mcp"]) {
    test(`${workspace} pins the ${dependency} that apps/web's ${WARDLEY_RENDERER} draws with`, () => {
      assert.equal(manifest(workspace).dependencies?.[dependency], rendererDependency(WARDLEY_RENDERER, dependency));
    });
  }
}

test("packages/notations compares its .storm reader with the @miragon/event-storming-dsl apps/web's renderer parses with", () => {
  const dependency = "@miragon/event-storming-dsl";
  assert.equal(
    manifest("packages/notations").devDependencies?.[dependency],
    rendererDependency("@miragon/event-storming-renderer", dependency),
  );
});
