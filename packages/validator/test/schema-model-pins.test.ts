/**
 * The validator checks a Team Topology, a Context Map or a Value Chain with
 * the schema model its canvas parses it with. The renderer apps/web draws
 * with pins its schema model exactly, so a renderer bump without the
 * validator's pin would let the save gate pass files the new canvas refuses
 * (#266): both move in one PR.
 * The CML serializer apps/web exports a Context Map with (#284) moves with
 * them: on a schema model of its own it would write a map by other patterns
 * and roles than the canvas draws. Read from the lockfile, whatever apps/web
 * declares itself.
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
const validator = JSON.parse(read("../package.json")) as { dependencies: Record<string, string> };

/** "0.11.2(zod@4.6.7)" → "0.11.2": a lockfile version without its peer suffix */
const bare = (version: string | undefined): string | undefined => version?.replace(/\(.*$/, "");

/** the schema model an apps/web dependency resolves, as the lockfile has it */
function schemaModelOf(pkg: string, schemaModel: string): string {
  const resolved = lock.importers["apps/web"]?.dependencies?.[pkg]?.version;
  assert.ok(resolved, `apps/web resolves ${pkg}`);
  const version = bare(lock.snapshots[`${pkg}@${resolved}`]?.dependencies?.[schemaModel]);
  assert.ok(version, `${pkg} depends on ${schemaModel}`);
  return version;
}

for (const [renderer, schemaModel] of [
  ["@miragon/team-topologies-renderer", "@miragon/team-topologies-schema-model"],
  ["@miragon/context-maps-renderer", "@miragon/context-maps-schema-model"],
  ["@miragon/value-chain-renderer", "@miragon/value-chain-schema-model"],
] as const) {
  test(`the validator pins the ${schemaModel} that apps/web's ${renderer} draws with`, () => {
    assert.equal(validator.dependencies[schemaModel], schemaModelOf(renderer, schemaModel));
  });
}

test("apps/web's @miragon/context-maps-cml writes CML from the schema model its Context Maps renderer draws with", () => {
  const schemaModel = "@miragon/context-maps-schema-model";
  assert.equal(
    schemaModelOf("@miragon/context-maps-cml", schemaModel),
    schemaModelOf("@miragon/context-maps-renderer", schemaModel),
  );
});
