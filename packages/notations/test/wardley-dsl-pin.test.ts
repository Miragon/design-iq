/**
 * extract.ts reads a Wardley Map with @miragon/wardley-dsl because the canvas
 * does: the text writes no ids, the parser derives them from the names, so
 * the ids get_view reports, a todo anchors to and presence outlines are the
 * canvas's only while both parse with one release. The renderer apps/web
 * draws with pins its wardley-dsl exactly; a bump of the renderer without
 * this pin (or of this pin alone) would let the two derive different ids
 * (#275): both move in one PR. The validator and the read-only MCP server
 * bundle this package and install its dependencies from npm, so they pin the
 * same release. Read from the lockfile, whatever apps/web declares itself.
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

const DSL = "@miragon/wardley-dsl";
const RENDERER = "@miragon/wardley-renderer";

/** "0.7.1(zod@4.6.7)" → "0.7.1": a lockfile version without its peer suffix */
const bare = (version: string | undefined): string | undefined => version?.replace(/\(.*$/, "");

function rendererDsl(): string {
  const renderer = lock.importers["apps/web"]?.dependencies?.[RENDERER]?.version;
  assert.ok(renderer, `apps/web resolves ${RENDERER}`);
  const dsl = bare(lock.snapshots[`${RENDERER}@${renderer}`]?.dependencies?.[DSL]);
  assert.ok(dsl, `${RENDERER} depends on ${DSL}`);
  return dsl;
}

for (const workspace of ["packages/notations", "packages/validator", "packages/mcp"]) {
  test(`${workspace} pins the ${DSL} that apps/web's ${RENDERER} draws with`, () => {
    const manifest = JSON.parse(read(`../../../${workspace}/package.json`)) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(manifest.dependencies?.[DSL], rendererDsl());
  });
}
