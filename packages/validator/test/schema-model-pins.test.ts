/**
 * The validator checks a Team Topology or a Context Map with the schema model
 * its canvas parses it with. The renderer apps/web draws with pins its schema
 * model exactly, so a renderer bump without the validator's pin would let the
 * save gate pass files the new canvas refuses (#266): both move in one PR.
 * Read from the lockfile, whatever apps/web declares itself.
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

for (const [renderer, schemaModel] of [
  ["@miragon/team-topologies-renderer", "@miragon/team-topologies-schema-model"],
  ["@miragon/context-maps-renderer", "@miragon/context-maps-schema-model"],
] as const) {
  test(`the validator pins the ${schemaModel} that apps/web's ${renderer} draws with`, () => {
    const resolved = lock.importers["apps/web"]?.dependencies?.[renderer]?.version;
    assert.ok(resolved, `apps/web resolves ${renderer}`);
    const canvasModel = bare(lock.snapshots[`${renderer}@${resolved}`]?.dependencies?.[schemaModel]);
    assert.ok(canvasModel, `${renderer} depends on ${schemaModel}`);
    assert.equal(validator.dependencies[schemaModel], canvasModel);
  });
}
